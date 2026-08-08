/**
 * Phase 6 (first slice) — verified pin names for parts whose compiled footprint
 * exposes only positional pins.
 *
 * `HY2111-GB` resolves via the curated (most-trusted) footprint path, but
 * footprinter's `sot23_6` has no pin names, so it previously got 0/2 real pins.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { curatedPinout } from "../src/design/curatedPinouts.js";
import { resolveComponent, SOURCE } from "../src/design/resolver.js";

test("HY2111-GB resolves both logical pins for real via the curated pinout", async () => {
  const resolved = await resolveComponent(
    { ref_id: "U6", part_number: "HY2111-GB", part_class: "power", package: "SOT-23-6" },
    { logicalPinsByRef: { U6: ["VDD", "GND"] }, allowNetwork: false }
  );

  const pins = resolved.resolution.pins;
  assert.equal(pins.real, true, "both pins must resolve for real, not positionally");
  assert.equal(pins.source, SOURCE.CURATED);
  assert.equal(pins.realCount, 2);
  assert.equal(pins.totalCount, 2);

  assert.equal(pins.value.VDD, "pin5", "VDD is pin 5 on this part");
  assert.equal(pins.value.GND, "pin6", "GND maps to VSS, pin 6");
  assert.equal(pins.perPin.VDD.via, "exact");
  assert.equal(pins.perPin.GND.via, "synonym", "GND matches VSS by standard equivalence");
  assert.ok(pins.perPin.VDD.evidence, "a curated pin mapping must carry evidence");
});

test("no PIN_NOT_FOUND is raised once the pinout is curated", async () => {
  const resolved = await resolveComponent(
    { ref_id: "U6", part_number: "HY2111-GB", part_class: "power", package: "SOT-23-6" },
    { logicalPinsByRef: { U6: ["VDD", "GND"] }, allowNetwork: false }
  );
  assert.deepEqual(
    resolved.errors.filter((e) => e.code === "PIN_NOT_FOUND"),
    []
  );
});

test("a pin the part genuinely lacks still fails, rather than being invented", async () => {
  const resolved = await resolveComponent(
    { ref_id: "U6", part_number: "HY2111-GB", part_class: "power", package: "SOT-23-6" },
    { logicalPinsByRef: { U6: ["VDD", "SDA"] }, allowNetwork: false }
  );

  assert.equal(resolved.resolution.pins.perPin.VDD.real, true);
  assert.equal(
    resolved.resolution.pins.perPin.SDA.real,
    false,
    "HY2111-GB is a battery protection IC with no SDA pin"
  );
  assert.equal(resolved.resolution.pins.real, false, "one unmatched pin makes the map unsafe");
  assert.ok(resolved.errors.some((e) => e.code === "PIN_NOT_FOUND" && e.target === "U6.SDA"));
});

test("the package guard refuses a curated pinout for the wrong package", () => {
  // Same part number, different package => not the part we verified.
  const result = curatedPinout("HY2111-GB", "SOIC-8");
  assert.equal(result.ok, false);
  assert.match(result.reason, /refusing to apply/);
});

test("a pinout is never applied to a different part in the same package", () => {
  // LP103SB6F is also SOT-23-6 but has a completely different pinout. Keying by
  // package instead of part number would have handed it HY2111-GB's pins.
  const result = curatedPinout("LP103SB6F", "SOT-23-6");
  assert.equal(result.ok, false, "no curated pinout exists for this part yet");
  assert.match(result.reason, /no curated pinout/);
});

test("every curated pinout entry carries evidence of pad-numbering correspondence", () => {
  const result = curatedPinout("HY2111-GB", "SOT-23-6");
  assert.equal(result.ok, true);
  assert.ok(result.evidence, "evidence is mandatory");
  assert.match(
    result.evidence,
    /verified empirically|pad-numbering|pin N is the same physical pin/i,
    "evidence must state why pad numbering corresponds (D-023)"
  );
});
