/**
 * Conversational modification (Phase 8).
 *
 * The end-to-end proof (real NL request -> v2, and a deliberately-bad move
 * blocked by the real DRC re-run) lives in `scripts/run-modification.js`, which
 * needs network + a compile. These tests pin the deterministic layer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildValidatedDesign } from "../src/design/validatedDesign.js";
import { generateGridPlacement, PLACEMENT_SOURCE, componentSizesFrom } from "../src/design/placement.js";
import {
  applyModification,
  validateInstructionShape,
  resolvePlacement,
  INSTRUCTION_TYPE,
} from "../src/design/modification.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const upstream = JSON.parse(
  await fs.readFile(path.resolve(here, "../../test-fixtures/smart_dustbin.json"), "utf8")
);
const design = buildValidatedDesign(upstream).design;

// Real footprint extents, measured from a compiled board.
const SIZES = {
  U1: { width_mm: 10.0, height_mm: 10.0 },
  U2: { width_mm: 4.5, height_mm: 4.5 },
  U3: { width_mm: 15.8, height_mm: 13.2 },
  U4: { width_mm: 7.3, height_mm: 7.1 },
  U5: { width_mm: 9.4, height_mm: 7.5 },
  U6: { width_mm: 3.8, height_mm: 2.5 },
  U7: { width_mm: 4.4, height_mm: 7.0 },
};

const reposition = (refId, placement) => ({
  type: INSTRUCTION_TYPE.REPOSITION,
  target: { ref_id: refId },
  placement,
});

// ---------------------------------------------------------------------------
// Placement is explicit state
// ---------------------------------------------------------------------------

test("ValidatedDesign carries explicit placement for every component", () => {
  assert.ok(design.placement, "placement is part of the schema");
  for (const component of design.components) {
    const seat = design.placement.components[component.ref_id];
    assert.ok(seat, `${component.ref_id} is placed`);
    assert.equal(typeof seat.x_mm, "number");
    assert.equal(seat.source, PLACEMENT_SOURCE.AUTO_GRID);
  }
});

test("the default generator reproduces the old compile-time grid exactly", () => {
  // Guards the Phase 8 refactor: promoting placement out of the compiler must
  // not have moved any v1 component.
  const outline = design.constraints.board_outline;
  const regenerated = generateGridPlacement(design.components, outline);
  assert.deepEqual(regenerated.components, design.placement.components);
  // Spot-check against values computed by hand from the original formula.
  assert.deepEqual(
    { x: design.placement.components.U1.x_mm, y: design.placement.components.U1.y_mm },
    { x: -25, y: 15 }
  );
});

test("placement generation is deterministic", () => {
  const a = generateGridPlacement(design.components, design.constraints.board_outline);
  const b = generateGridPlacement(design.components, design.constraints.board_outline);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// Instruction shape
// ---------------------------------------------------------------------------

test("UNSUPPORTED is surfaced as such, not reinterpreted", () => {
  const result = validateInstructionShape({
    type: INSTRUCTION_TYPE.UNSUPPORTED,
    requested_change_class: "component_swap",
    reason: "asked to swap the BLE module for WiFi",
  });
  assert.equal(result.ok, false);
  assert.equal(result.unsupported, true);
  assert.equal(result.errors[0].detail.requestedChangeClass, "component_swap");
});

test("malformed instructions are rejected per mode", () => {
  const bad = [
    { type: "SOMETHING_ELSE" },
    reposition("U3", { mode: "edge", edge: "diagonal", margin_mm: 5 }),
    reposition("U3", { mode: "edge", edge: "left", margin_mm: -1 }),
    reposition("U3", { mode: "delta", dx_mm: "five", dy_mm: 0 }),
    reposition("U3", { mode: "absolute", x_mm: Number.NaN, y_mm: 0 }),
    reposition("U3", { mode: "relative_to", ref_id: "U1", direction: "sideways", distance_mm: 5 }),
    reposition("U3", { mode: "teleport" }),
  ];
  for (const instruction of bad) {
    assert.equal(validateInstructionShape(instruction).ok, false, JSON.stringify(instruction));
  }
});

// ---------------------------------------------------------------------------
// Geometry comes from the deterministic layer, not the model
// ---------------------------------------------------------------------------

test("edge mode resolves millimetres from the board and the REAL footprint size", () => {
  // The instruction carries only "left" and 5 — no coordinates.
  const resolved = resolvePlacement(reposition("U3", { mode: "edge", edge: "left", margin_mm: 5 }), design, SIZES);
  // -50 (board minX) + 5 (margin) + 7.9 (half of U3's real 15.8mm width)
  assert.equal(resolved.to.x_mm, -37.1);
  assert.equal(resolved.to.y_mm, 15, "the other axis is untouched");
});

test("a wrong size estimate changes the answer — which is why real sizes are used", () => {
  const withEstimate = resolvePlacement(
    reposition("U3", { mode: "edge", edge: "left", margin_mm: 5 }),
    design,
    {} // no real sizes -> fallback estimate
  );
  assert.notEqual(
    withEstimate.to.x_mm,
    -37.1,
    "the fallback estimate places it differently; real footprint extents matter"
  );
});

test("relative_to anchors on another component's real position", () => {
  const resolved = resolvePlacement(
    reposition("U3", { mode: "relative_to", ref_id: "U1", direction: "below", distance_mm: 10 }),
    design,
    SIZES
  );
  assert.equal(resolved.to.x_mm, design.placement.components.U1.x_mm);
  assert.equal(resolved.to.y_mm, design.placement.components.U1.y_mm - 10);
});

test("delta is relative to the component's current position", () => {
  const before = design.placement.components.U7;
  const resolved = resolvePlacement(reposition("U7", { mode: "delta", dx_mm: -5, dy_mm: 3 }), design, SIZES);
  assert.equal(resolved.to.x_mm, before.x_mm - 5);
  assert.equal(resolved.to.y_mm, before.y_mm + 3);
});

// ---------------------------------------------------------------------------
// Deterministic validation
// ---------------------------------------------------------------------------

test("a component that does not exist is COMPONENT_NOT_FOUND", () => {
  const result = applyModification(reposition("U99", { mode: "delta", dx_mm: 1, dy_mm: 0 }), design, SIZES);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "COMPONENT_NOT_FOUND");
});

test("a move that leaves the board is BOARD_CONSTRAINT_FAILURE", () => {
  const result = applyModification(reposition("U3", { mode: "absolute", x_mm: 49, y_mm: 15 }), design, SIZES);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "BOARD_CONSTRAINT_FAILURE"));
});

test("a move onto another component is rejected before compiling", () => {
  const onTopOfU1 = design.placement.components.U1;
  const result = applyModification(
    reposition("U3", { mode: "absolute", x_mm: onTopOfU1.x_mm, y_mm: onTopOfU1.y_mm }),
    design,
    SIZES
  );
  assert.equal(result.ok, false);
  const overlap = result.errors.find((e) => e.code === "DRC_FAILURE");
  assert.ok(overlap, "cheap pre-check catches the obvious case");
  assert.equal(overlap.detail.collidesWith, "U1");
});

test("the pre-check is a guard, NOT a substitute for the real DRC re-run", () => {
  // U3 halfW 7.9 + U1 halfW 5.0 = 12.9. At dx = 13.0 the bbox check passes —
  // but courtyards are larger than component bodies, and the real DRC re-run
  // rejects this exact placement ("Courtyard of U3 overlaps with courtyard of
  // U1"). Proven end-to-end in scripts/run-modification.js.
  const result = applyModification(reposition("U3", { mode: "absolute", x_mm: -38, y_mm: 15 }), design, SIZES);
  assert.equal(result.ok, true, "the cheap pre-check lets this through by 0.1mm");
});

// ---------------------------------------------------------------------------
// The transform is pure
// ---------------------------------------------------------------------------

test("applying a modification does not mutate the source design", () => {
  const before = structuredClone(design.placement.components.U7);
  const result = applyModification(reposition("U7", { mode: "delta", dx_mm: 0, dy_mm: -5 }), design, SIZES);

  assert.equal(result.ok, true);
  assert.deepEqual(design.placement.components.U7, before, "v1 is untouched");
  assert.notDeepEqual(result.design.placement.components.U7, before, "v2 has the new position");
});

test("a modified component is marked so a re-layout cannot silently discard it", () => {
  const result = applyModification(reposition("U7", { mode: "delta", dx_mm: 0, dy_mm: -5 }), design, SIZES);
  assert.equal(result.design.placement.components.U7.source, PLACEMENT_SOURCE.MODIFIED);
  assert.equal(
    result.design.placement.components.U1.source,
    PLACEMENT_SOURCE.AUTO_GRID,
    "untouched components keep their original provenance"
  );
});

test("componentSizesFrom reads real extents out of compiled output", () => {
  const circuitJson = [
    { type: "source_component", source_component_id: "s1", name: "U3" },
    { type: "pcb_component", source_component_id: "s1", pcb_component_id: "p1", width: 15.8, height: 13.2 },
  ];
  assert.deepEqual(componentSizesFrom(circuitJson), { U3: { width_mm: 15.8, height_mm: 13.2 } });
});
