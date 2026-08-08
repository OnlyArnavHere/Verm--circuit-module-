import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildValidatedDesign,
  VALIDATED_DESIGN_VERSION,
  RESOLUTION_SOURCE,
} from "../src/design/validatedDesign.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../test-fixtures");
const loadFixture = async (name) =>
  JSON.parse(await fs.readFile(path.join(fixturesDir, `${name}.json`), "utf8"));

test("rc_car: shape and content match the documented schema", async () => {
  const { design } = buildValidatedDesign(await loadFixture("rc_car"));

  assert.equal(design.validated_design_version, VALIDATED_DESIGN_VERSION);
  assert.equal(design.upstream_schema_version, "1.0");
  assert.equal(design.components.length, 3);
  assert.deepEqual(
    design.components.map((c) => c.ref_id),
    ["U1", "U2", "U3"]
  );
  assert.equal(design.constraints.layer_count, 4);
  assert.equal(design.constraints.board_outline.width_mm, 100);
});

test("rc_car: redundant POWER_1/POWER_2 are deduplicated and recorded", async () => {
  const { design, modifications } = buildValidatedDesign(await loadFixture("rc_car"));

  const netNames = design.nets.map((n) => n.name);
  assert.ok(netNames.includes("POWER_RAIL_3V3"), "the superset net survives");
  assert.ok(!netNames.includes("POWER_1"), "POWER_1 is subsumed");
  assert.ok(!netNames.includes("POWER_2"), "POWER_2 is subsumed");

  // Never silent: every removal carries original value + reason.
  const removals = modifications.filter((m) => m.detectedBy === "NET_SUBSUMED_BY_LARGER_NET");
  assert.equal(removals.length, 2);
  for (const modification of removals) {
    assert.ok(modification.originalValue, "the original connections are preserved");
    assert.match(modification.reason, /fully contained in "POWER_RAIL_3V3"/);
  }
});

test("rc_car: unresolvable footprints produce FOOTPRINT_NOT_FOUND, not a guess", async () => {
  const { design, errors, compilable } = buildValidatedDesign(await loadFixture("rc_car"));

  // None of rc_car's packages (SOP-16, MAPBGA-289, QFN-16-EP(4x4)) are curated.
  for (const component of design.components) {
    assert.equal(component.footprint.value, null, `${component.ref_id} must not be guessed`);
    assert.equal(component.footprint.source, RESOLUTION_SOURCE.UNRESOLVED);
  }
  assert.equal(errors.filter((e) => e.code === "FOOTPRINT_NOT_FOUND").length, 3);
  assert.equal(compilable, false, "a design with unresolved footprints is not compilable");
});

test("pins stay unresolved rather than being invented", async () => {
  const { design, errors } = buildValidatedDesign(await loadFixture("rc_car"));

  for (const component of design.components) {
    assert.equal(component.pins.source, RESOLUTION_SOURCE.UNRESOLVED);
  }
  for (const net of design.nets) {
    for (const member of net.members) {
      assert.equal(member.pad, null, "no fabricated pad numbers");
      assert.equal(member.physicalPin, null);
      assert.ok(member.logicalPin, "the logical pin from upstream is preserved");
    }
  }
  assert.equal(errors.filter((e) => e.code === "PIN_NOT_FOUND").length, 3);
});

test("a curated package resolves and carries its expected pad count", () => {
  const { design } = buildValidatedDesign({
    schema_version: "1.0",
    design_name: "t",
    components: [
      { ref_id: "U1", part_class: "power", part_number: "HY2111-GB", package: "SOT-23-6", quantity: 1 },
    ],
    nets: [],
    constraints: { layer_count: 2, board_outline: { shape: "rectangle", width_mm: 20, height_mm: 20 } },
  });

  const [component] = design.components;
  assert.equal(component.footprint.value, "sot23_6");
  assert.equal(component.footprint.expectedPadCount, 6);
  assert.equal(component.footprint.source, RESOLUTION_SOURCE.CURATED);
  assert.ok(component.footprint.evidence);
});

test("nets referencing an unknown component raise COMPONENT_NOT_FOUND", () => {
  const { errors } = buildValidatedDesign({
    schema_version: "1.0",
    design_name: "t",
    components: [
      { ref_id: "U1", part_class: "power", part_number: "X", package: "SOT-23-6", quantity: 1 },
    ],
    nets: [{ name: "N1", connections: ["U1.A", "U9.B"], net_class: "signal" }],
    constraints: { layer_count: 2, board_outline: { shape: "rectangle", width_mm: 10, height_mm: 10 } },
  });

  const notFound = errors.filter((e) => e.code === "COMPONENT_NOT_FOUND");
  assert.equal(notFound.length, 1);
  assert.equal(notFound[0].target, "U9.B");
});

test("a missing board outline raises BOARD_CONSTRAINT_FAILURE", () => {
  const { errors } = buildValidatedDesign({
    schema_version: "1.0",
    design_name: "t",
    components: [],
    nets: [],
    constraints: { layer_count: 2, board_outline: { shape: "rectangle" } },
  });
  assert.ok(errors.some((e) => e.code === "BOARD_CONSTRAINT_FAILURE"));
});

test("build is deterministic across repeated runs", async () => {
  const upstream = await loadFixture("noise_pollution_monitor");
  const a = JSON.stringify(buildValidatedDesign(upstream));
  const b = JSON.stringify(buildValidatedDesign(upstream));
  assert.equal(a, b);
});

test("all four fixtures build without throwing", async () => {
  for (const name of [
    "rc_car",
    "smart_dustbin",
    "gas_leakage_detector",
    "noise_pollution_monitor",
  ]) {
    const result = buildValidatedDesign(await loadFixture(name));
    assert.ok(result.design.components.length > 0, `${name} has components`);
    assert.equal(result.compilable, false, `${name} is not yet compilable (unresolved parts)`);
  }
});
