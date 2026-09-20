/**
 * In-process serial job worker.
 *
 * WHY NOT A QUEUE LIBRARY
 * -----------------------
 * Measured on this machine with warm caches: buildValidatedDesign 0.03s,
 * resolveComponents 0.04-0.12s, compileDesign 25-91s. The pipeline is ~100%
 * compile time -- tscircuit eval is 23-26s and artifact generation 2-65s,
 * dominated by the GLB. Cold, resolveComponents adds roughly 5.1s per
 * uncached part (build-coverage.js's measured figure).
 *
 * So the constraint is CONCURRENCY, not duration. One design takes about a
 * minute; two 90-second tscircuit compiles in one Node process contend for the
 * same event loop and CPU. Serialising one job at a time removes that, and a
 * Redis-backed queue would add a broker, a worker process and deploy surface to
 * manage a workload of one-to-few designs at ~1 minute each. Revisit if either
 * changes: multiple concurrent users, or a need for jobs to survive a restart.
 *
 * DURABILITY, stated plainly: this queue is IN MEMORY. A process restart loses
 * everything still queued, and any job left mid-run stays at its last persisted
 * status in MongoDB rather than being retried. Mongo remains the durable record
 * of what happened; the queue is not durable and is not pretending to be.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Job } from "../models/Job.js";
import { JOB_STATUS } from "../models/constants.js";
import { runPipeline, PipelineError } from "../design/pipeline.js";
import { STORAGE_BUCKET } from "./storage.js";
import { emitJobEvent } from "./events.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = path.resolve(here, "../../../artifacts");

/** Serial chain. Each enqueue appends; nothing runs in parallel. */
let chain = Promise.resolve();
let queuedCount = 0;
let running = null;

/**
 * Advance a job: persist the status, append to statusHistory, emit the event.
 *
 * Deliberately one function so the three never drift apart -- the durable record
 * and the live event always describe the same transition. The event name and
 * envelope reuse the `job:received` shape already established in routes/jobs.js;
 * this adds statuses to that pattern rather than inventing a second one.
 */
async function advance(job, status, message, extra = {}) {
  job.status = status;
  job.statusHistory.push({ status, message });
  for (const [k, v] of Object.entries(extra)) job[k] = v;
  await job.save();

  emitJobEvent(`job:${status}`, {
    jobId: job.jobId,
    designName: job.designName,
    status,
    message,
    ...extra,
  });
}

/**
 * Run one job to completion.
 *
 * The failure policy is the authority here (PROJECT_PLAN Phase 10):
 *   - validator throw   -> FAILED  (nothing to resolve or compile)
 *   - tscircuit throw   -> FAILED  (no artifacts can exist)
 *   - upload failure    -> FAILED  (section 0: local-only output is not done)
 *   - everything else   -> CONTINUE, recorded as a finding
 *
 * In particular a non-compilable design, unresolved parts, mocked pins and a
 * missing artifact all CONTINUE. Partial resolution is a legitimate outcome that
 * resolver.js models explicitly, and `compilable` / `mockedPinCount` /
 * `hasAllOutputs()` already express quality. COMPLETED means the pipeline ran to
 * the end -- never that the board is good.
 */
async function processJob(jobId) {
  const job = await Job.findOne({ jobId });
  if (!job) return;

  try {
    const result = await runPipeline({
      upstream: job.upstream.payload,
      outDir: path.join(ARTIFACT_ROOT, jobId, "v1"),
      jobId,
      version: 1,
      upload: true,
      onStage: async (stage, d) => {
        switch (stage) {
          case "validating":
            await advance(job, JOB_STATUS.VALIDATING, "Validating design structure and electrical rules.");
            break;
          case "validated":
            // compilable was already computed at intake; recorded again here
            // because the pipeline is the authority once a job is running.
            await advance(
              job,
              JOB_STATUS.VALIDATING,
              `Validated: compilable=${d.compilable}, ${d.validationErrors.length} error(s), ` +
                `${d.electricalFindings} electrical finding(s).`,
              { compilable: d.compilable, validationErrors: d.validationErrors },
            );
            break;
          case "resolving":
            await advance(job, JOB_STATUS.RESOLVING, `Resolving ${d.components} component(s) against the catalogue.`);
            break;
          case "resolved":
            await advance(
              job,
              JOB_STATUS.RESOLVING,
              `Resolved ${d.realFootprints}/${d.totalComponents} real footprint(s); ` +
                `${d.mockedPinCount} component(s) have mocked pins. ` +
                `Partial resolution is not a failure — it is recorded, not fatal.`,
              { mockedPinCount: d.mockedPinCount },
            );
            break;
          case "compiling":
            await advance(job, JOB_STATUS.COMPILING, "Compiling to tscircuit.");
            break;
          case "compiled":
            await advance(
              job,
              JOB_STATUS.COMPILING,
              `Compiled: ${d.elements} elements, ${d.pads} pads, ${d.traces} traces in ${d.compileMs}ms. ` +
                `padIntegrity=${d.padIntegrity} netsRealized=${d.netsRealized}.`,
            );
            break;
          case "generating":
            await advance(job, JOB_STATUS.GENERATING, "Generating the four required outputs.");
            break;
          case "generated":
            await advance(
              job,
              JOB_STATUS.GENERATING,
              `Generated ${d.produced.length}/4 output(s)` +
                (d.missing.length ? `; missing: ${d.missing.join(", ")}.` : "."),
            );
            break;
          case "uploading":
            await advance(job, JOB_STATUS.UPLOADING, `Uploading ${d.files} artifact(s) to object storage.`);
            break;
          case "uploaded":
            await advance(job, JOB_STATUS.UPLOADING, `Uploaded ${d.count} file(s) to ${d.bucket}.`);
            break;
          default:
            break;
        }
      },
    });

    // Map uploads onto Job's ArtifactRefSchema, which requires kind, format,
    // storageKey and bucket. The manifest's own output shape is NOT the same
    // shape -- passing it straight through fails schema validation, which is
    // exactly what happened the first time this ran end to end.
    //
    // `mocked` is deliberately false: it labels placeholder FILE CONTENT, and
    // these are real derived files. That the board is not manufacturable is a
    // separate fact, carried by compilable / mockedPinCount / the manifest's
    // manufacturableReason -- conflating the two would mislabel real artifacts.
    const outputs = {};
    for (const up of result.uploads) {
      if (!up.primary) continue;
      outputs[up.kind] = {
        kind: up.kind,
        format: up.format,
        storageKey: up.key,
        bucket: STORAGE_BUCKET,
        bytes: up.bytes,
        contentType: up.contentType,
        checksumSha256: up.sha256,
        mocked: false,
      };
    }

    await advance(
      job,
      JOB_STATUS.COMPLETED,
      `Pipeline complete: ${4 - result.missing.length}/4 output(s), ` +
        `${result.realFootprints}/${result.totalComponents} real footprint(s), ` +
        `mockedPinCount=${result.mockedPinCount}. ` +
        `COMPLETED means the pipeline ran to the end, not that the board is manufacturable.`,
      { outputs },
    );
  } catch (error) {
    const stage = error instanceof PipelineError ? error.stage : "unknown";
    // Re-read from Mongo rather than reusing `job`. If the failure came from a
    // bad field assignment, the in-memory document still carries it and saving
    // FAILED would fail validation too -- leaving the job stuck at its last
    // good status with no record of why. That is precisely what happened when
    // an unmapped `outputs` shape was assigned before save.
    const fresh = (await Job.findOne({ jobId }).catch(() => null)) ?? job;
    await advance(
      fresh,
      JOB_STATUS.FAILED,
      `Failed at ${stage}: ${error.message}`,
    ).catch((persistError) => {
      console.error(`[jobRunner] could not persist FAILED for ${jobId}: ${persistError.message}`);
    });
    // Not rethrown: one failed job must not break the chain for the next.
    console.error(`[jobRunner] ${jobId} failed at ${stage}: ${error.message}`);
  }
}

/** Append a job to the serial chain. Returns immediately. */
export function enqueueJob(jobId) {
  queuedCount += 1;
  chain = chain
    .then(async () => {
      running = jobId;
      try {
        await processJob(jobId);
      } finally {
        running = null;
        queuedCount -= 1;
      }
    })
    .catch((error) => {
      // processJob already handles its own failures; this guards the chain
      // itself so one unexpected throw cannot stop every later job.
      running = null;
      queuedCount -= 1;
      console.error(`[jobRunner] chain error: ${error.message}`);
    });
  return { queued: queuedCount };
}

/** For tests and health reporting. */
export function runnerStatus() {
  return { queued: queuedCount, running };
}

/** Await the chain draining. Tests only — nothing in the request path waits. */
export function drain() {
  return chain;
}
