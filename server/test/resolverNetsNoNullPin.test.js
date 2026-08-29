/**
 * GUARD: a schema-2.0 member with a role and no logicalPin must NEVER produce a
 * "REF.null" string anywhere in the resolution path.
 *
 * The defect this guards: every script consumer flattened normalized nets into
 * v1-style strings with `${m.ref_id}.${m.logicalPin}`. Schema 2.0 asserts no pin
 * name (D-076) -- validatedDesign sets `pin: null` and carries `role` alongside
 * -- so that template produced the literal "U1.null" for every member and threw
 * `role` away. The resolver then tried to resolve a pin named "null" on every
 * part, which no part has. One guaranteed error per component on every v2
 * design, independent of which part was selected, and the error CODE was
 * decided purely by naming completeness (PART_CAPABILITY_MISMATCH when the pin
 * set was complete, PIN_NOT_FOUND when it was not).
 *
 * Every Phase 5 measurement taken through the harness was invalid because of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildValidatedDesign } from "../src/design/validatedDesign.js";
import { isSchemaV2, pinRequestsByRef } from "../src/design/normalizeUpstream.js";
import { resolverNets, compilerNets } from "../scripts/resolver-nets.js";

const V2 = {
  schema_version: "2.0",
  design_name: "guard",
  components: [
    { ref_id: "U1", part_number: "PART-A", package: "SOIC-8" },
    { ref_id: "U2", part_number: "PART-B", package: "SOIC-8" },
  ],
  nets: [
    { name: "I2C_1_CLOCK", interface: "I2C", net_class: "signal",
      members: [{ ref_id: "U1", role: "CLOCK" }, { ref_id: "U2", role: "CLOCK" }] },
    { name: "GND", interface: "Power", net_class: "power",
      members: [{ ref_id: "U1", role: "GROUND" }, { ref_id: "U2", role: "GROUND" }] },
  ],
};

const V1 = {
  design_name: "guard-v1",
  components: [{ ref_id: "U1", part_number: "PART-A", package: "SOIC-8" }],
  nets: [{ name: "I2C_SDA", net_class: "signal", connections: ["U1.SDA"] }],
};

test("v2 members never yield a REF.null string in resolver nets", () => {
  const nets = resolverNets(V2, buildValidatedDesign(V2).design, isSchemaV2);
  const serialised = JSON.stringify(nets);
  assert.ok(!serialised.includes(".null"), `found a .null reference: ${serialised}`);
  assert.ok(!serialised.includes('"null"'), "a literal \"null\" string leaked into the nets");
});

test("v2 members carry the declared role through to pin requests", () => {
  const nets = resolverNets(V2, buildValidatedDesign(V2).design, isSchemaV2);
  const requests = pinRequestsByRef(nets);
  assert.deepEqual(
    requests.U1.map((r) => r.role).sort(),
    ["CLOCK", "GROUND"],
    "roles must survive into the resolver's pin requests",
  );
  for (const request of [...requests.U1, ...requests.U2]) {
    assert.equal(request.roleIsDeclared, true, "v2 roles are DECLARED, not inferred");
    assert.equal(request.logicalPin, null, "v2 asserts no pin name (D-076)");
    assert.notEqual(request.role, "null");
    assert.notEqual(request.role, null);
  }
});

test("resolveComponents takes the role-based path for these nets", () => {
  const nets = resolverNets(V2, buildValidatedDesign(V2).design, isSchemaV2);
  // This is the exact condition resolver.js:371 switches on.
  assert.ok(
    nets.some((n) => Array.isArray(n.members)),
    "nets must carry a members array or the resolver silently uses the v1 path",
  );
});

test("v1 documents still resolve by asserted pin name, not by role", () => {
  const nets = resolverNets(V1, buildValidatedDesign(V1).design, isSchemaV2);
  const requests = pinRequestsByRef(nets);
  assert.equal(requests.U1.length, 1);
  assert.equal(requests.U1[0].logicalPin, "SDA", "v1 keeps its asserted pin name");
  assert.equal(
    requests.U1[0].roleIsDeclared, false,
    "a v1 role is evidence about a fabricated string, never a declared fact",
  );
});

test("the compiler shape is kept separate and still v1-style", () => {
  // toTscircuit.js traces by splitting "REF.PIN", so this shape must persist.
  const nets = compilerNets(buildValidatedDesign(V1).design);
  assert.deepEqual(nets[0].connections, ["U1.SDA"]);
  // Documented limitation, asserted so it is a known state rather than a
  // surprise: the compiler has no role-aware path, so v2 still yields REF.null
  // here. That lives in server/src/compile/, outside the harness fix.
  const v2 = compilerNets(buildValidatedDesign(V2).design);
  assert.ok(
    v2[0].connections.every((c) => c.endsWith(".null")),
    "if this ever stops being true, the compiler gained a role path -- update the note",
  );
});
