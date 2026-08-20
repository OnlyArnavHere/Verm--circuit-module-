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
  assert.ok(files.length >= 5, `expected at least 5 fixtures, got ${files.length}`);

  for (const file of files) {
    const fixture = await loadFixture(file);
    const result = checkIntakeShape(fixture);
    assert.equal(result.ok, true, `${file} should pass intake: ${result.message}`);
    // Fixtures now span both schema versions: the four original v1 documents
    // plus captured dunkai output. Assert intake reports the version the file
    // actually declares rather than pinning every fixture to 1.0.
    assert.equal(result.schemaVersion, fixture.schema_version);
    assert.ok(["1.0", "2.0"].includes(result.schemaVersion), `${file}: ${result.schemaVersion}`);
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
  // 2.0 is now SUPPORTED (role-based nets), so this needs a version that is
  // genuinely unknown — otherwise the test silently stops testing anything.
  const result = checkIntakeShape({ schema_version: "9.9", design_name: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "UNSUPPORTED_SCHEMA_VERSION");
});

test("schema 2.0 is accepted and reported as such", () => {
  const result = checkIntakeShape({
    schema_version: "2.0",
    design_name: "x",
    components: [
      { ref_id: "U1", part_class: "processing", part_number: "P1", package: "SOP-8", quantity: 1 },
      { ref_id: "U2", part_class: "sensor", part_number: "P2", package: "SOP-8", quantity: 1 },
    ],
    nets: [
      {
        name: "I2C_1_CLOCK",
        interface: "I2C",
        net_class: "signal",
        members: [
          { ref_id: "U1", role: "CLOCK" },
          { ref_id: "U2", role: "CLOCK" },
        ],
      },
    ],
    constraints: { layer_count: 4, board_outline: { shape: "rectangle", width_mm: 100, height_mm: 60 } },
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.schemaVersion, "2.0");
});

test("a schema 2.0 net may not smuggle asserted pin names back in", () => {
  const result = checkIntakeShape({
    schema_version: "2.0",
    design_name: "x",
    components: [
      { ref_id: "U1", part_class: "processing", part_number: "P1", package: "SOP-8", quantity: 1 },
    ],
    nets: [
      {
        name: "BAD",
        interface: "I2C",
        net_class: "signal",
        members: [{ ref_id: "U1", role: "CLOCK" }],
        connections: ["U1.SCL"],
      },
    ],
    constraints: { layer_count: 4, board_outline: { shape: "rectangle", width_mm: 100, height_mm: 60 } },
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("connections is not valid in schema 2.0")));
});

test("a schema 2.0 net with an unknown role is rejected", () => {
  const result = checkIntakeShape({
    schema_version: "2.0",
    design_name: "x",
    components: [
      { ref_id: "U1", part_class: "processing", part_number: "P1", package: "SOP-8", quantity: 1 },
    ],
    nets: [
      {
        name: "BAD",
        interface: "I2C",
        net_class: "signal",
        members: [{ ref_id: "U1", role: "SDA" }],
      },
    ],
    constraints: { layer_count: 4, board_outline: { shape: "rectangle", width_mm: 100, height_mm: 60 } },
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('role "SDA" is not a known role')));
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
