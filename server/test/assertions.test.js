/**
 * These run against REAL tscircuit output captured in test/fixtures/, not
 * hand-written mocks — the whole point is that the silent failure is real.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPadIntegrity, assertNetsRealized } from "../src/design/assertions.js";
import { collectTscircuitIssues } from "../src/design/tscircuitErrors.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = async (name) =>
  JSON.parse(await fs.readFile(path.join(here, "fixtures", name), "utf8"));

test("THE ZERO-PAD CASE: DFN-8-EP(2x3) reports no errors but is caught anyway", async () => {
  const circuitJson = await load("circuitjson-zero-pad-dfn.json");

  // First, confirm the premise: tscircuit itself is silent about this.
  const { errors: tscircuitErrors, warnings } = collectTscircuitIssues(circuitJson);
  assert.equal(tscircuitErrors.length, 0, "premise: tscircuit reports no errors here");
  assert.equal(warnings.length, 0, "premise: tscircuit reports no warnings either");

  // Our independent assertion must still fail it.
  const result = assertPadIntegrity(circuitJson);
  assert.equal(result.ok, false, "a zero-pad component must not pass");
  assert.equal(result.errors[0].code, "FOOTPRINT_NOT_FOUND");
  assert.match(result.errors[0].message, /ZERO pads/i);
  assert.equal(result.errors[0].target, "U1");
});

test("a healthy footprint passes the pad assertion", async () => {
  const circuitJson = await load("circuitjson-healthy-sot23.json");
  const result = assertPadIntegrity(circuitJson);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("pad count mismatch against the resolved footprint is a hard failure", async () => {
  const circuitJson = await load("circuitjson-healthy-sot23.json");
  // sot23_6 really produces 6 pads; claim we expected 8.
  const result = assertPadIntegrity(circuitJson, new Map([["U1", 8]]));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /6 pads but the resolved footprint promised 8/);
});

test("expected pad count matching the real count passes", async () => {
  const circuitJson = await load("circuitjson-healthy-sot23.json");
  const result = assertPadIntegrity(circuitJson, new Map([["U1", 6]]));
  assert.equal(result.ok, true);
});

test("empty circuit json fails rather than vacuously passing", () => {
  const result = assertPadIntegrity([]);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "FOOTPRINT_NOT_FOUND");
});

test("declared connections with zero routed traces is a ROUTING_FAILURE", async () => {
  const circuitJson = await load("circuitjson-zero-pad-dfn.json");
  const design = {
    nets: [{ name: "I2C_3", net_class: "signal", connections: ["U1.SDA", "U2.SDA"] }],
  };
  const result = assertNetsRealized(circuitJson, design);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "ROUTING_FAILURE");
});

test("a partially routed board fails — not just a fully unrouted one", async () => {
  // tscircuit skips individual traces whose ports lack coordinates without
  // erroring, so "at least one trace exists" would wave through a broken board.
  const circuitJson = [
    { type: "pcb_trace", pcb_trace_id: "t1" },
    { type: "pcb_component", pcb_component_id: "c1" },
    { type: "pcb_smtpad", pcb_component_id: "c1" },
  ];
  const design = {
    nets: [
      { name: "GND", net_class: "ground", connections: ["U1.GND", "U2.GND", "U3.GND"] },
    ],
  };
  const result = assertNetsRealized(circuitJson, design);
  assert.equal(result.ok, false, "1 of 2 expected traces must fail");
  assert.match(result.errors[0].message, /Only 1 of 2 expected connections/);
});

test("nets with no connections require no traces", async () => {
  const circuitJson = await load("circuitjson-zero-pad-dfn.json");
  const design = { nets: [{ name: "GND", net_class: "ground", connections: [] }] };
  assert.equal(assertNetsRealized(circuitJson, design).ok, true);
});

test("tscircuit's own footprint error maps onto FOOTPRINT_NOT_FOUND", async () => {
  const circuitJson = await load("circuitjson-invalid-footprint.json");
  const { errors } = collectTscircuitIssues(circuitJson);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "FOOTPRINT_NOT_FOUND");
  assert.match(errors[0].message, /footprint/i);
  assert.equal(errors[0].detail.tscircuitType, "source_invalid_component_property_error");
});

test("unmapped *_error types still surface instead of being dropped", () => {
  const { errors, unmappedTypes } = collectTscircuitIssues([
    { type: "some_future_error", message: "unknown failure" },
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "UNSUPPORTED_COMPONENT");
  assert.deepEqual(unmappedTypes, ["some_future_error"]);
});
