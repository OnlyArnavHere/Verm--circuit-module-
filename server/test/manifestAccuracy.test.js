/**
 * Phase 5.6 fix #1 — manifest `real` claims must be verified against compiled
 * ground truth, never asserted from a pre-compile assumption.
 *
 * The bug: `model_3d.source` was set equal to the *footprint's* source with a
 * `pendingCompileConfirmation` flag that was written once and never read. U6
 * (HY2111-GB) reported `model_3d.real = true` while having no 3D model at all —
 * a false-real claim, the exact failure mode the system exists to prevent.
 *
 * These tests assert the claim tracks reality in BOTH directions, so the fix
 * cannot regress into "always real" or "always mock".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveComponent, confirmModel3d, SOURCE } from "../src/design/resolver.js";

/** Minimal compiled Circuit JSON wiring one ref to one cad_component. */
function circuitJsonFor(ref, cad) {
  return [
    { type: "source_component", source_component_id: "s1", name: ref },
    { type: "pcb_component", pcb_component_id: "p1", source_component_id: "s1" },
    ...(cad ? [{ type: "cad_component", cad_component_id: "c1", pcb_component_id: "p1", ...cad }] : []),
  ];
}

const componentStub = (overrides = {}) => ({
  ref_id: "U1",
  part_number: "TEST-PART",
  part_class: "power",
  package: "SOT-23-6",
  resolution: {
    footprint: { value: "sot23_6", source: SOURCE.CURATED, real: true },
    pads: { value: null, source: SOURCE.CURATED, real: true },
    model_3d: { value: null, source: SOURCE.UNRESOLVED, real: false, unconfirmed: true },
    symbol: { value: "chip_box", source: SOURCE.GENERATED, real: false },
    pins: { value: {}, source: SOURCE.MOCK, real: false },
  },
  ...overrides,
});

test("resolution NEVER claims a 3D model before compilation", async () => {
  // Even for a component whose footprint resolves via the most-trusted path.
  const resolved = await resolveComponent(
    { ref_id: "U1", part_number: "HY2111-GB", part_class: "power", package: "SOT-23-6" },
    { logicalPinsByRef: { U1: ["VDD", "GND"] }, allowNetwork: false }
  );

  assert.equal(resolved.resolution.footprint.real, true, "footprint does resolve");
  assert.equal(
    resolved.resolution.model_3d.real,
    false,
    "model_3d must NOT be claimed real before compile, even with a real footprint"
  );
  assert.equal(resolved.resolution.model_3d.source, SOURCE.UNRESOLVED);
});

test("THE BUG: a real footprint with no 3D model reports real=false", () => {
  const component = componentStub();
  // U6's real situation: curated footprint compiled, no cad_component at all.
  const { errors } = confirmModel3d(circuitJsonFor("U1", null), [component]);

  assert.equal(
    component.resolution.model_3d.real,
    false,
    "a component with no 3D model must never report real=true"
  );
  assert.equal(component.resolution.model_3d.source, SOURCE.MOCK);
  assert.equal(component.resolution.model_3d.confirmedFromCompiledOutput, true);
  assert.equal(errors[0].code, "MODEL_3D_NOT_FOUND");
});

test("a component WITH a catalogue model reports real=true and records the URL", () => {
  const component = componentStub();
  const url = "https://modules.easyeda.com/3dmodel/abc123";
  const { errors } = confirmModel3d(
    circuitJsonFor("U1", { model_obj_url: url }),
    [component]
  );

  assert.equal(component.resolution.model_3d.real, true);
  assert.equal(component.resolution.model_3d.source, SOURCE.PARTS_ENGINE);
  assert.equal(component.resolution.model_3d.value, url);
  assert.deepEqual(errors, [], "a confirmed model raises no finding");
});

test("a procedurally generated body is 'generated', not real", () => {
  const component = componentStub();
  confirmModel3d(circuitJsonFor("U1", { model_jscad: { type: "cube" } }), [component]);

  assert.equal(component.resolution.model_3d.source, SOURCE.GENERATED);
  assert.equal(
    component.resolution.model_3d.real,
    false,
    "a generated body is deterministic but is not the part's real model"
  );
});

test("a cad_component with no model reference is not counted as real", () => {
  const component = componentStub();
  confirmModel3d(circuitJsonFor("U1", { some_other_field: 1 }), [component]);
  assert.equal(component.resolution.model_3d.real, false);
});

test("the dead pendingCompileConfirmation flag is gone", async () => {
  const resolved = await resolveComponent(
    { ref_id: "U1", part_number: "HY2111-GB", part_class: "power", package: "SOT-23-6" },
    { logicalPinsByRef: {}, allowNetwork: false }
  );
  assert.equal(
    "pendingCompileConfirmation" in resolved.resolution.model_3d,
    false,
    "a flag that is written but never read must not exist — it is what caused the bug"
  );
});
