import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkIntakeShape } from "../src/upstream/intakeCheck.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../test-fixtures");

const loadFixture = async (name) =>
  JSON.parse(await fs.readFile(path.join(fixturesDir, name), "utf8"));

test("accepts every real Hardware Agent fixture", async () => {
  const files = (await fs.readdir(fixturesDir)).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 4, "expected 4 fixtures");

  for (const file of files) {
    const result = checkIntakeShape(await loadFixture(file));
    assert.equal(result.ok, true, `${file} should pass intake: ${result.message}`);
    assert.equal(result.schemaVersion, "1.0");
  }
});

test("known-bad designs still pass INTAKE — they are structurally valid", async () => {
  // The SCK<->MOSI bug and the split I2C half-nets are *design* errors, caught by
  // the deterministic validator in later phases. Intake must not reject them, or
  // "upstream sent garbage" becomes indistinguishable from "upstream sent a
  // well-formed but electrically wrong design".
  for (const file of ["smart_dustbin.json", "noise_pollution_monitor.json"]) {
    const result = checkIntakeShape(await loadFixture(file));
    assert.equal(result.ok, true, `${file} is structurally valid`);
  }
});

test("rejects non-object roots", () => {
  for (const bad of [null, [], "string", 42]) {
    const result = checkIntakeShape(bad);
    assert.equal(result.ok, false);
    assert.equal(result.code, "MALFORMED_UPLOAD");
  }
});

test("rejects an unsupported schema_version by its own code", () => {
  const result = checkIntakeShape({ schema_version: "2.0", design_name: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "UNSUPPORTED_SCHEMA_VERSION");
});

test("reports every missing top-level section, not just the first", () => {
  const result = checkIntakeShape({ schema_version: "1.0", design_name: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "MALFORMED_UPLOAD");
  assert.ok(result.issues.some((i) => i.includes("components")));
  assert.ok(result.issues.some((i) => i.includes("nets")));
  assert.ok(result.issues.some((i) => i.includes("constraints")));
});

test("rejects duplicate ref_ids, which make every REF.PIN ambiguous", async () => {
  const design = await loadFixture("rc_car.json");
  design.components.push({ ...design.components[0] });

  const result = checkIntakeShape(design);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("duplicated")));
});

test("rejects connections that are not REF.PIN shaped", async () => {
  const design = await loadFixture("rc_car.json");
  design.nets[0].connections = ["U1", "U2.GND.EXTRA", 7];

  const result = checkIntakeShape(design);
  assert.equal(result.ok, false);
  assert.equal(result.issues.filter((i) => i.includes('"REF.PIN"')).length, 3);
});

test("rejects a board outline without numeric dimensions", async () => {
  const design = await loadFixture("rc_car.json");
  design.constraints.board_outline.width_mm = "100mm";

  const result = checkIntakeShape(design);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("width_mm")));
});

test("warns without failing on unknown part_class and net_class", async () => {
  const design = await loadFixture("rc_car.json");
  design.components[0].part_class = "quantum_flux";
  design.nets[0].net_class = "telepathy";

  const result = checkIntakeShape(design);
  assert.equal(result.ok, true, "unknown enums are warnings, not hard failures");
  assert.equal(result.warnings.length, 2);
});
