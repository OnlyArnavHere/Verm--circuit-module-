import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Job } from "../src/models/Job.js";
import { JOB_STATUS } from "../src/models/constants.js";
import { buildValidatedDesign } from "../src/design/validatedDesign.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../test-fixtures");
const loadFixture = async (name) =>
  JSON.parse(await fs.readFile(path.join(fixturesDir, name), "utf8"));

/** Mirrors what routes/jobs.js does at intake. No DB needed to build a doc. */
const jobFor = (payload) => {
  const validated = buildValidatedDesign(payload);
  return new Job({
    jobId: "test-job",
    designName: payload.design_name,
    status: JOB_STATUS.RECEIVED,
    compilable: validated.compilable,
    mockedPinCount: null,
    validationErrors: validated.errors,
    upstream: { schemaVersion: payload.schema_version, payload, receivedAt: new Date() },
  });
};

test("compilable reaches the API response and reflects the real design", async () => {
  const body = jobFor(await loadFixture("dunkai_real_v1_unfixed.json")).toPublicJSON();
  assert.equal(typeof body.compilable, "boolean");
  assert.equal(body.compilable, false, "this fixture has unresolved footprints and pins");
});

test("mockedPinCount is null — 'not yet resolved', never coerced to 0", async () => {
  // The whole point of the field. 0 would assert "this design has no mocked
  // pins", which nobody has checked: resolveComponents() is not run at intake.
  // Same defect shape as MISSING_PINS rendering an unknown as a clean pass.
  const body = jobFor(await loadFixture("dunkai_real_v2_rolebased.json")).toPublicJSON();
  assert.equal(body.mockedPinCount, null);
  assert.notEqual(body.mockedPinCount, 0, "null must not degrade to 0");
  assert.ok("mockedPinCount" in body, "must be present, not omitted");
});

test("both correctness fields sit next to hasAllOutputs, not buried", async () => {
  // Placement is load-bearing: hasAllOutputs counts files and reads like a green
  // light. The correctness signal has to be impossible to miss beside it.
  const body = jobFor(await loadFixture("rc_car.json")).toPublicJSON();
  const keys = Object.keys(body);
  const at = keys.indexOf("hasAllOutputs");
  assert.ok(at >= 0);
  assert.deepEqual(keys.slice(at, at + 3), ["hasAllOutputs", "compilable", "mockedPinCount"]);
});

test("hasAllOutputs true must not be readable as correctness", async () => {
  const job = jobFor(await loadFixture("rc_car.json"));
  const artifact = {
    kind: "circuit", format: "svg", storageKey: "k", bucket: "b", generatedAt: new Date(),
  };
  job.outputs = {
    circuit: { ...artifact },
    schematic: { ...artifact, kind: "schematic" },
    pcb: { ...artifact, kind: "pcb" },
    model3d: { ...artifact, kind: "model3d" },
  };
  const body = job.toPublicJSON();
  assert.equal(body.hasAllOutputs, true, "all four files present");
  assert.equal(body.compilable, false, "yet the design is NOT compilable");
  // This combination is exactly why the fields are adjacent.
});

test("a job with no design validation keeps compilable null, not false", () => {
  // null = nobody checked. false = checked and it failed. Collapsing the two
  // would make an unvalidated job indistinguishable from a bad one.
  const body = new Job({ jobId: "j", designName: "d", status: JOB_STATUS.RECEIVED }).toPublicJSON();
  assert.equal(body.compilable, null);
  assert.notEqual(body.compilable, false);
  assert.equal(body.mockedPinCount, null);
});
