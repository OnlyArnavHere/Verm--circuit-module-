/**
 * The design pipeline, extracted from scripts/run-poc.js so a job worker and the
 * CLI run the SAME code rather than two implementations that drift.
 *
 *   validate -> electrical checks -> resolve (real first, mock per field)
 *            -> compile -> tscircuit -> artifacts -> upload -> manifest
 *
 * Three CLI couplings are severed here:
 *   - input      : an upstream OBJECT is passed in, not a fixture path read from disk
 *   - output dir : supplied by the caller, so a job writes to artifacts/<jobId>/v<n>
 *   - reporting  : an `onStage` callback replaces ~40 console.log calls. Those calls
 *                  were not decoration -- each marked a real pipeline boundary, and
 *                  they map one-to-one onto the job status transitions.
 *
 * FAILURE POLICY (the authority is PROJECT_PLAN Phase 10's table):
 * Only three things abort the run -- a validator throw, a tscircuit throw, and an
 * upload failure. Everything else CONTINUES and is reported as a finding, because
 * partial resolution is a legitimate outcome, not an error: resolver.js has a
 * labelled MOCK path, a design with mocked pins still compiles and still produces
 * all four artifacts, and `mockedPinCount` exists precisely to record it. Treating
 * that as a failure would throw away real outputs.
 */
import fs from "node:fs";
import path from "node:path";

import { buildValidatedDesign } from "./validatedDesign.js";
import { runElectricalChecks } from "./electricalChecks.js";
import { resolveComponents, resolutionSummary, isReal } from "./resolver.js";
import { isSchemaV2 } from "./normalizeUpstream.js";
import { compileDesign } from "../compile/compile.js";
import { putObject, artifactKey, STORAGE_BUCKET } from "../services/storage.js";

/** The four required outputs (PROJECT_PLAN section 0). */
const REQUIRED_KINDS = ["circuit", "schematic", "pcb", "model3d"];

const CONTENT_TYPES = {
  svg: "image/svg+xml",
  glb: "model/gltf-binary",
  json: "application/json",
  txt: "text/plain",
  kicad_pcb: "application/x-kicad-pcb",
  kicad_sch: "application/x-kicad-schematic",
  gbr: "application/vnd.gerber",
  drl: "application/vnd.excellon",
};
const contentTypeFor = (filename) =>
  CONTENT_TYPES[filename.split(".").pop()] ?? "application/octet-stream";

/** Thrown when a stage fails in a way that must abort the run. */
export class PipelineError extends Error {
  constructor(stage, message, cause) {
    super(message);
    this.name = "PipelineError";
    this.stage = stage;
    this.cause = cause;
  }
}

/**
 * Resolution nets: role-based, carrying `members`.
 *
 * Duplicated from scripts/resolver-nets.js rather than imported, because src/
 * must not depend on scripts/. Kept byte-identical in behaviour; see that file
 * for why flattening to `${ref_id}.${logicalPin}` was wrong (schema 2.0 leaves
 * logicalPin null, which asked the resolver for a pin named "null").
 */
function resolverNets(upstream, validatedDesign) {
  const declared = isSchemaV2(upstream);
  return (validatedDesign.nets ?? []).map((net) => ({
    name: net.name,
    net_class: net.net_class,
    interface: net.interface ?? null,
    members: (net.members ?? []).map((m) => ({
      ref_id: m.ref_id,
      role: m.role ?? null,
      logicalPin: m.logicalPin ?? null,
      roleIsDeclared: declared,
    })),
  }));
}

/** Compiler nets: v1 "REF.PIN" strings, which toTscircuit still traces by. */
function compilerNets(validatedDesign) {
  return (validatedDesign.nets ?? []).map((net) => ({
    name: net.name,
    net_class: net.net_class,
    connections: (net.members ?? []).map((m) => `${m.ref_id}.${m.logicalPin}`),
  }));
}

/**
 * Run the full pipeline.
 *
 * @param {object}   opts
 * @param {object}   opts.upstream    the design document (job.upstream.payload)
 * @param {string}   opts.outDir      where artifacts are written
 * @param {string}   opts.jobId       used for the storage key namespace
 * @param {number}   [opts.version]   version under that job, default 1
 * @param {boolean}  [opts.upload]    default true; false skips S3 entirely
 * @param {(stage: string, detail: object) => (void|Promise<void>)} [opts.onStage]
 *        Called at each pipeline boundary. Awaited, so a caller can persist
 *        before the next stage starts.
 * @returns {Promise<{manifest, outputs, missing, compilable, mockedPinCount,
 *                    realFootprints, uploads, summary, compiled}>}
 */
export async function runPipeline({
  upstream,
  outDir,
  jobId,
  version = 1,
  upload = true,
  onStage = () => {},
}) {
  const report = async (stage, detail = {}) => { await onStage(stage, detail); };

  // --- validate ------------------------------------------------------------
  // A validator THROW aborts: without a validated design there is nothing to
  // resolve or compile. A design that merely validates as non-compilable does
  // NOT abort -- that is a finding about the design, and the artifacts it would
  // produce are still worth having.
  let validated;
  let electrical;
  await report("validating", {});
  try {
    electrical = runElectricalChecks(upstream);
    validated = buildValidatedDesign(upstream);
  } catch (error) {
    throw new PipelineError("validating", `Design validation threw: ${error.message}`, error);
  }
  await report("validated", {
    compilable: validated.compilable,
    validationErrors: validated.errors,
    electricalFindings: electrical.errors.length,
    modifications: validated.modifications.length + electrical.modifications.length,
  });

  // --- resolve -------------------------------------------------------------
  // Never aborts. Unresolved parts are recorded, not fatal.
  await report("resolving", { components: upstream.components.length });
  const resolution = await resolveComponents(
    upstream.components,
    resolverNets(upstream, validated.design),
  );
  const realFootprints = resolution.components.filter((c) => isReal(c.resolution.footprint.source));
  const mockedPinCount = resolution.components.filter(
    (c) => !c.resolution.pins?.real,
  ).length;
  await report("resolved", {
    realFootprints: realFootprints.length,
    totalComponents: resolution.components.length,
    mockedPinCount,
    resolutionErrors: resolution.errors.length,
  });

  // --- compile -------------------------------------------------------------
  // A tscircuit throw aborts: no artifacts can exist without it.
  const deduped = {
    ...upstream,
    nets: compilerNets(validated.design),
    placement: validated.design.placement,
  };
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  await report("compiling", {});
  let compiled;
  try {
    compiled = await compileDesign({
      upstream: deduped,
      resolvedComponents: resolution.components,
      outDir,
    });
  } catch (error) {
    throw new PipelineError("compiling", `tscircuit compilation threw: ${error.message}`, error);
  }

  // Recomputed AFTER compilation: confirmModel3d corrects model_3d in place, so
  // the manifest must carry the confirmed values, not the pre-compile ones.
  const summary = resolutionSummary(resolution.components);
  await report("compiled", {
    elements: compiled.stats.elements,
    pads: compiled.stats.pads,
    traces: compiled.stats.traces,
    cadComponents: compiled.stats.cadComponents,
    compileMs: compiled.compileMs,
    padIntegrity: compiled.assertions.padIntegrity.ok,
    netsRealized: compiled.assertions.netsRealized.ok,
    drc: compiled.drc.ran
      ? { total: compiled.drc.total, failures: compiled.drc.errors.length }
      : null,
  });

  // --- artifacts -----------------------------------------------------------
  // A missing artifact does NOT abort: hasAllOutputs() already expresses partial
  // completion, and three real files beat discarding everything over a fourth.
  await report("generating", {});
  const missing = [];
  const produced = [];
  for (const kind of REQUIRED_KINDS) {
    const artifact = compiled.artifacts[kind];
    if (artifact && fs.existsSync(artifact.path)) produced.push({ kind, ...artifact });
    else missing.push(kind);
  }
  await report("generated", {
    produced: produced.map((p) => ({ kind: p.kind, filename: p.filename, bytes: p.bytes })),
    missing,
  });

  // --- upload --------------------------------------------------------------
  // An upload failure DOES abort. PROJECT_PLAN section 0 is explicit that an
  // output which exists only locally is not done, so a job whose artifacts never
  // became durable must not report success.
  const uploads = [];
  if (upload) {
    await report("uploading", { files: produced.length });
    const files = [];
    for (const artifact of produced) {
      files.push(artifact);
      for (const extra of artifact.additional ?? []) files.push({ kind: artifact.kind, ...extra });
    }
    for (const file of files) {
      const key = artifactKey({ jobId, version, kind: file.kind, filename: file.filename });
      try {
        const put = await putObject({
          key,
          body: fs.readFileSync(file.path),
          contentType: contentTypeFor(file.filename),
        });
        uploads.push({
          kind: file.kind,
          key,
          bytes: put.bytes,
          sha256: file.sha256,
          // Carried so a caller can build a storage reference without
          // re-deriving any of it (Job's ArtifactRefSchema needs all of these).
          filename: file.filename,
          format: file.format ?? file.filename.split(".").pop(),
          contentType: contentTypeFor(file.filename),
          primary: produced.some((a) => a.filename === file.filename),
        });
      } catch (error) {
        throw new PipelineError(
          "uploading",
          `Upload failed for "${file.filename}": ${error.message}. ` +
            `Artifacts exist locally but are not durable, so this job is not complete.`,
          error,
        );
      }
    }
    await report("uploaded", { count: uploads.length, bucket: STORAGE_BUCKET });
  }

  // --- manifest ------------------------------------------------------------
  const manifest = {
    jobId,
    version,
    design_name: upstream.design_name,
    generatedBy: "pipeline",
    bucket: upload ? STORAGE_BUCKET : null,

    // Per-field resolution for EVERY component -- never a single mock/real flag.
    components: resolution.components.map((component) => ({
      ref_id: component.ref_id,
      part_number: component.part_number,
      package: component.package,
      resolution: Object.fromEntries(
        Object.entries(component.resolution).map(([field, value]) => [
          field,
          {
            source: value.source,
            real: value.real,
            value: value.value,
            ...(value.lcsc ? { lcsc: value.lcsc } : {}),
            ...(value.reason ? { reason: value.reason } : {}),
            ...(value.evidence ? { evidence: value.evidence } : {}),
            ...(typeof value.realCount === "number"
              ? { realCount: value.realCount, totalCount: value.totalCount, perPin: value.perPin }
              : {}),
          },
        ]),
      ),
    })),
    resolutionSummary: summary,

    outputs: Object.fromEntries(
      REQUIRED_KINDS.map((kind) => {
        const artifact = compiled.artifacts[kind];
        return [
          kind,
          artifact
            ? {
                format: artifact.format,
                filename: artifact.filename,
                bytes: artifact.bytes,
                sha256: artifact.sha256,
                s3Key:
                  uploads.find((u) => u.kind === kind && u.sha256 === artifact.sha256)?.key ?? null,
                additional: (artifact.additional ?? []).map((a) => ({
                  filename: a.filename,
                  bytes: a.bytes,
                })),
              }
            : null,
        ];
      }),
    ),

    validation: {
      electricalFindings: electrical.errors.map((e) => ({
        code: e.code,
        target: e.target,
        message: e.message,
      })),
      modifications: [...validated.modifications, ...electrical.modifications].map((m) => ({
        target: m.target,
        detectedBy: m.detectedBy,
        reason: m.reason,
      })),
      assertions: {
        padIntegrity: compiled.assertions.padIntegrity.ok,
        netsRealized: compiled.assertions.netsRealized.ok,
        failures: compiled.assertions.padIntegrity.errors.map((e) => e.message),
      },
      tscircuitErrors: compiled.tscircuitIssues.errors.length,
      drc: {
        ran: compiled.drc.ran,
        total: compiled.drc.total,
        failures: compiled.drc.errors.length,
        warnings: compiled.drc.warnings.length,
        byType: compiled.drc.byType,
      },
      model3dConfirmedFromCompiledOutput: true,
    },

    stats: compiled.stats,
    manufacturable: false,
    manufacturableReason:
      "Pin assignment is positional, not the verified pinout (pins.source = mock). " +
      "Layout and footprints may be real, but this board must not be fabricated.",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifest,
    outputs: manifest.outputs,
    missing,
    compilable: validated.compilable,
    mockedPinCount,
    realFootprints: realFootprints.length,
    totalComponents: resolution.components.length,
    uploads,
    summary,
    compiled,
    validationErrors: validated.errors,
    electrical,
    validated,
    resolution,
  };
}
