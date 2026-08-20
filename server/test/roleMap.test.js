import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveRole,
  allocateGpio,
  rolesAreCompatible,
  candidatesFor,
  ALLOCATED_ROLES,
  KNOWN_ROLES,
} from "../src/design/roleMap.js";
import { matchLogicalPin } from "../src/design/pinout.js";
import { normalizeUpstream, pinRequestsByRef } from "../src/design/normalizeUpstream.js";
import { runElectricalChecks } from "../src/design/electricalChecks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(readFileSync(path.resolve(here, "../../test-fixtures", name), "utf8"));

// A real catalogue pinout: MCP9808-class I2C temperature sensor.
const sensorPinout = {
  ok: true,
  padCount: 9,
  pins: { SDA: "pin1", SCL: "pin2", ALERT: "pin3", GND: "pin4", A2: "pin5", A1: "pin6", A0: "pin7", VDD: "pin8", EP: "pin9" },
};

test("a role resolves to the pin the part actually exposes", () => {
  assert.equal(resolveRole("I2C", "CLOCK", sensorPinout, matchLogicalPin).pad, "pin2");
  assert.equal(resolveRole("I2C", "DATA", sensorPinout, matchLogicalPin).pad, "pin1");
  assert.equal(resolveRole("Power", "GROUND", sensorPinout, matchLogicalPin).pad, "pin4");
  assert.equal(resolveRole("Power", "SUPPLY", sensorPinout, matchLogicalPin).pad, "pin8");
});

test("an unresolvable role fails rather than guessing a lookalike", () => {
  // This part has no SPI at all. The wrong answer here would be a plausible pin.
  const result = resolveRole("SPI", "MOSI", sensorPinout, matchLogicalPin);
  assert.equal(result.ok, false);
  assert.ok(result.tried.includes("MOSI"));
  assert.ok(result.availablePins.includes("SDA"), "should report what the part does have");
});

test("VIN is never accepted as a supply rail (D-032)", () => {
  // TP4110's only supply pin is VIN, which is a charge input, not a logic rail.
  const charger = { ok: true, padCount: 2, pins: { VIN: "pin1", GND: "pin2" } };
  assert.equal(resolveRole("Power", "SUPPLY", charger, matchLogicalPin).ok, false);
});

test("rail synonyms and numbered variants still work through the role layer", () => {
  const part = { ok: true, padCount: 2, pins: { VSS1: "pin1", VCC: "pin2" } };
  assert.equal(resolveRole("Power", "GROUND", part, matchLogicalPin).pad, "pin1");
  assert.equal(resolveRole("Power", "SUPPLY", part, matchLogicalPin).pad, "pin2");
});

test("one role per wire, except a complementary TX/RX pair", () => {
  assert.equal(rolesAreCompatible(["CLOCK", "CLOCK", "CLOCK"]), true);
  assert.equal(rolesAreCompatible(["TX", "RX"]), true);
  assert.equal(rolesAreCompatible(["CLOCK", "DATA"]), false);
  assert.equal(rolesAreCompatible(["CLOCK", "MOSI"]), false);
});

test("GPIO allocates the lowest-numbered pad and never reuses one", () => {
  const mcu = { ok: true, padCount: 4, pins: { IO2: "pin3", IO0: "pin1", IO1: "pin2", VDD: "pin4" } };
  const taken = new Set();
  const first = allocateGpio(mcu, taken);
  assert.equal(first.matchedName, "IO0");
  taken.add(first.pad);
  const second = allocateGpio(mcu, taken);
  assert.equal(second.matchedName, "IO1", "must not hand out the same pad twice");
  taken.add(second.pad);
  taken.add("pin3");
  assert.equal(allocateGpio(mcu, taken).ok, false, "exhausted I/O must fail, not wrap around");
});

// --- regressions from the first real v2 capture ---------------------------

test("two chip selects on one controller resolve to DIFFERENT pads", () => {
  // Regression: resolveRole returned the first match every time, so every
  // peripheral's CS landed on the same pad — silently shorting them together.
  const mcu = { ok: true, padCount: 4, pins: { CS0: "pin1", CS1: "pin2", SCK: "pin3", VDD: "pin4" } };
  const taken = new Set();
  const a = resolveRole("SPI", "CHIP_SELECT", mcu, matchLogicalPin, taken);
  assert.equal(a.ok, true);
  taken.add(a.pad);
  const b = resolveRole("SPI", "CHIP_SELECT", mcu, matchLogicalPin, taken);
  assert.equal(b.ok, true);
  assert.notEqual(b.pad, a.pad, "a second CS must not reuse the first CS pad");
});

test("CHIP_SELECT and GPIO are per-net roles; bus signals are not", () => {
  assert.equal(ALLOCATED_ROLES.has("CHIP_SELECT"), true);
  assert.equal(ALLOCATED_ROLES.has("GPIO"), true);
  assert.equal(ALLOCATED_ROLES.has("CLOCK"), false, "one shared clock pad per part");
  assert.equal(ALLOCATED_ROLES.has("DATA"), false);
});

test("the same role on two different interfaces is not one terminal", () => {
  // Regression: a terminal keyed as `ref.role` collapsed U1's I2C clock and U1's
  // SPI clock into "U1.CLOCK", producing a false split-bus INVALID_NET.
  const design = {
    schema_version: "2.0",
    nets: [
      { name: "I2C_1_CLOCK", interface: "I2C", net_class: "signal",
        members: [{ ref_id: "U1", role: "CLOCK" }, { ref_id: "U2", role: "CLOCK" }] },
      { name: "SPI_1_CLOCK", interface: "SPI", net_class: "signal",
        members: [{ ref_id: "U1", role: "CLOCK" }, { ref_id: "U3", role: "CLOCK" }] },
    ],
  };
  assert.equal(runElectricalChecks(design).errors.length, 0);
});

test("a genuinely split v2 bus is still caught", () => {
  // The check must stay capable of firing — proving the fix above did not just
  // disable it.
  const design = {
    schema_version: "2.0",
    nets: [
      { name: "I2C_A", interface: "I2C", net_class: "signal",
        members: [{ ref_id: "U1", role: "CLOCK" }, { ref_id: "U2", role: "CLOCK" }] },
      { name: "I2C_B", interface: "I2C", net_class: "signal",
        members: [{ ref_id: "U1", role: "CLOCK" }, { ref_id: "U3", role: "CLOCK" }] },
    ],
  };
  const errors = runElectricalChecks(design).errors;
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "INVALID_NET");
});

// --- the captured fixture pair --------------------------------------------

test("the v1 fixture carries the upstream bugs and the v2 fixture does not", () => {
  const v1 = runElectricalChecks(fixture("dunkai_real_v1_unfixed.json")).errors;
  const v2 = runElectricalChecks(fixture("dunkai_real_v2_rolebased.json")).errors;

  assert.equal(v1.filter((e) => e.code === "ELECTRICAL_CONFLICT").length, 5,
    "v1: SCK tied to MOSI twice, SCL tied to SDA three times");
  assert.equal(v1.filter((e) => e.code === "INVALID_NET").length, 2);
  assert.equal(v2.length, 0, "v2 cannot represent those defects");
});

test("v2 members declare their role; v1 members only have it inferred", () => {
  const v1 = normalizeUpstream(fixture("dunkai_real_v1_unfixed.json"));
  const v2 = normalizeUpstream(fixture("dunkai_real_v2_rolebased.json"));

  assert.ok(v1.nets.every((n) => n.members.every((m) => m.roleIsDeclared === false)));
  assert.ok(v2.nets.every((n) => n.members.every((m) => m.roleIsDeclared === true)));

  // v1 asserts a pin name; v2 asserts none.
  assert.ok(v1.nets.some((n) => n.members.some((m) => typeof m.logicalPin === "string")));
  assert.ok(v2.nets.every((n) => n.members.every((m) => m.logicalPin === null)));

  const requests = pinRequestsByRef(v2.nets);
  assert.ok(Object.values(requests).flat().every((r) => r.roleIsDeclared && r.interface));
});

test("every role a fixture uses has candidates defined for its interface", () => {
  const v2 = fixture("dunkai_real_v2_rolebased.json");
  for (const net of v2.nets) {
    for (const member of net.members) {
      assert.ok(KNOWN_ROLES.has(member.role), `unknown role ${member.role}`);
      assert.notEqual(candidatesFor(net.interface, member.role), null,
        `no candidates for ${net.interface}/${member.role}`);
    }
  }
});
