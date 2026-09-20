/**
 * GUARD: writing FAILED must never reuse the in-flight document.
 *
 * The defect this guards, found by the first real end-to-end run rather than by
 * inspection: the worker assigned the MANIFEST's output shape to `job.outputs`,
 * which is not Job's ArtifactRefSchema. The save threw on validation AFTER a
 * successful 19-file upload. The catch then wrote FAILED using the same
 * in-memory document -- which still carried the bad assignment -- so that save
 * threw too, was swallowed, and the job sat at `uploading` forever with no
 * record of why it stopped.
 *
 * Two separate failures, so two separate guards:
 *   1. buildArtifactRefs() must produce schema-valid refs      (the cause)
 *   2. markFailed() must re-read a clean document              (the trap)
 *
 * No live DB: Mongoose documents construct and validate offline, which is the
 * convention jobCorrectnessFields.test.js already uses.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Job } from "../src/models/Job.js";
import { JOB_STATUS } from "../src/models/constants.js";
import { buildArtifactRefs, markFailed } from "../src/services/jobRunner.js";

const BUCKET = "pcb-circuit-agent-dev-storage";

/** A job as it exists mid-run, just before the failing write. */
const inFlightJob = () =>
  new Job({
    jobId: "test-failed-path",
    designName: "guard",
    status: JOB_STATUS.UPLOADING,
    compilable: false,
    mockedPinCount: 2,
    upstream: { payload: { components: [], nets: [] }, receivedAt: new Date() },
    statusHistory: [{ status: JOB_STATUS.UPLOADING, message: "Uploading 4 artifact(s)." }],
  });

/** Exactly what the pipeline returns, including the non-primary extras. */
const UPLOADS = [
  { kind: "circuit", key: "jobs/j/v1/circuit/circuit-diagram.svg", bytes: 8584,
    sha256: "f5c4", filename: "circuit-diagram.svg", format: "svg",
    contentType: "image/svg+xml", primary: true },
  { kind: "pcb", key: "jobs/j/v1/pcb/board.kicad_pcb", bytes: 111496,
    sha256: "4387", filename: "board.kicad_pcb", format: "kicad_pcb",
    contentType: "application/x-kicad-pcb", primary: true },
  { kind: "pcb", key: "jobs/j/v1/pcb/board-F_Cu.gbr", bytes: 900,
    sha256: "dead", filename: "board-F_Cu.gbr", format: "gbr",
    contentType: "application/vnd.gerber", primary: false },
];

/** The shape that actually caused the bug — the manifest's, not the schema's. */
const MANIFEST_SHAPED = {
  circuit: { format: "svg", filename: "circuit-diagram.svg", bytes: 8584, sha256: "f5c4", s3Key: "jobs/j/v1/circuit/circuit-diagram.svg", additional: [] },
};

test("buildArtifactRefs produces refs that pass ArtifactRefSchema", () => {
  const job = inFlightJob();
  job.outputs = buildArtifactRefs(UPLOADS, BUCKET);
  const err = job.validateSync();
  assert.equal(err, undefined, `refs must validate; got: ${err?.message}`);
  for (const kind of ["circuit", "pcb"]) {
    const ref = job.outputs[kind];
    for (const field of ["kind", "format", "storageKey", "bucket"]) {
      assert.ok(ref[field], `${kind}.${field} is required by the schema and must be set`);
    }
  }
  assert.equal(job.outputs.circuit.bucket, BUCKET);
  assert.equal(job.outputs.pcb.storageKey, "jobs/j/v1/pcb/board.kicad_pcb");
});

test("non-primary extras (gerbers) are NOT written as top-level outputs", () => {
  // outputs is keyed by kind; the gerber shares kind "pcb" with the board file
  // and must not overwrite it.
  const outputs = buildArtifactRefs(UPLOADS, BUCKET);
  assert.equal(Object.keys(outputs).sort().join(","), "circuit,pcb");
  assert.equal(outputs.pcb.format, "kicad_pcb", "the primary artifact must win, not the extra");
});

test("the manifest shape really is invalid — the bug was real, not hypothetical", () => {
  const job = inFlightJob();
  job.outputs = MANIFEST_SHAPED;
  const err = job.validateSync();
  assert.ok(err, "manifest-shaped outputs must fail validation");
  for (const field of ["kind", "storageKey", "bucket"]) {
    assert.ok(
      Object.keys(err.errors).some((k) => k.endsWith(`.${field}`)),
      `validation must complain about the missing ${field}`,
    );
  }
});

test("failed-path-must-not-inherit-poisoned-document", async () => {
  // Poison a document exactly as the bug did, and prove it cannot be saved.
  const poisoned = inFlightJob();
  poisoned.outputs = MANIFEST_SHAPED;
  assert.ok(poisoned.validateSync(), "precondition: the in-flight doc is unsaveable");

  // The fresh read returns a clean document, as Mongo would.
  const fresh = inFlightJob();
  let savedDoc = null;
  fresh.save = async () => {
    const err = fresh.validateSync();
    if (err) throw err;          // behave like a real save
    savedDoc = fresh;
    return fresh;
  };

  const result = await markFailed(
    "test-failed-path",
    "uploading",
    "Upload failed for board.glb: connection reset",
    async () => fresh,
    poisoned,
  );

  assert.ok(savedDoc, "FAILED must actually persist, not throw and be swallowed");
  assert.equal(result.status, JOB_STATUS.FAILED, "status must be failed, not left at uploading");
  assert.notEqual(result.status, JOB_STATUS.UPLOADING, "must not be stuck mid-pipeline");

  const last = result.statusHistory.at(-1);
  assert.equal(last.status, JOB_STATUS.FAILED);
  assert.match(last.message, /Failed at uploading/, "must record WHERE it failed");
  assert.match(last.message, /connection reset/, "must record the REAL reason, not a generic one");
});

test("markFailed falls back to the in-flight doc when the re-read fails", async () => {
  // A re-read can fail (Mongo blip). Better a FAILED write from the poisoned doc
  // than no record at all — but it must still be attempted, not skipped.
  const fallback = inFlightJob();
  let saved = false;
  fallback.save = async () => { saved = true; return fallback; };

  const result = await markFailed(
    "test-failed-path",
    "compiling",
    "tscircuit threw",
    async () => { throw new Error("mongo unavailable"); },
    fallback,
  );
  assert.ok(saved, "must still attempt to persist via the fallback");
  assert.equal(result.status, JOB_STATUS.FAILED);
  assert.match(result.statusHistory.at(-1).message, /Failed at compiling/);
});

test("markFailed returns null rather than throwing when there is no document at all", async () => {
  const result = await markFailed("missing", "resolving", "x", async () => null, null);
  assert.equal(result, null, "a vanished job must not crash the worker chain");
});
