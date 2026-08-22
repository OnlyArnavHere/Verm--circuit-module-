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

  // Reclassified, deliberately. This asserted PIN_NOT_FOUND while the resolver's
  // curated branch omitted padCount, which left capabilityConfirmed false and
  // made a capability claim impossible for curated parts. With padCount now
  // taken from the real footprint, HY2111-GB is 6 of 6 pads named and genuinely
  // has no SDA — so the honest code is the stronger one. The test's intent is
  // unchanged: the pin still fails rather than being invented.
  const sda = resolved.errors.find((e) => e.target === "U6.SDA");
  assert.equal(sda.code, "PART_CAPABILITY_MISMATCH");
  assert.equal(sda.detail.capabilityConfirmed, true);
});

test("the package guard refuses a curated pinout for the wrong package", () => {
  // Same part number, different package => not the part we verified.
  const result = curatedPinout("HY2111-GB", "SOIC-8");
  assert.equal(result.ok, false);
  assert.match(result.reason, /refusing to apply/);
});

test("a pinout is never applied to a different part in the same package", () => {
  // HY2111-GB and LP103SB6F are BOTH SOT-23-6 with genuinely different pinouts.
  // Keying by package instead of part number would have handed one the other's
  // pins — this asserts they stay distinct.
  const hy = curatedPinout("HY2111-GB", "SOT-23-6");
  const lp = curatedPinout("LP103SB6F", "SOT-23-6");

  assert.equal(hy.ok, true);
  assert.equal(lp.ok, true);

  // Entries store the part's REAL pin names; logical GND reaches HY2111-GB's
  // VSS through the rail-equivalence rule at match time, not via the table.
  assert.equal(hy.pins.VSS, "pin6", "HY2111-GB's ground is VSS on pin 6");
  assert.equal(lp.pins.GND, "pin2", "LP103SB6F's ground is GND on pin 2");
  assert.notDeepEqual(hy.pins, lp.pins, "same package, different pinouts");
});

test("an uncurated part in a curated package inherits nothing", () => {
  const result = curatedPinout("SOME-OTHER-SOT23-PART", "SOT-23-6");
  assert.equal(result.ok, false, "sharing a package grants no pinout");
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

// ---------------------------------------------------------------------------
// LP103SB6F — the first entry sourced via the LLM-assisted pipeline
// ---------------------------------------------------------------------------

test("LP103SB6F GND resolves for real from the confirmed extraction", async () => {
  const resolved = await resolveComponent(
    { ref_id: "U5", part_number: "LP103SB6F", part_class: "power", package: "SOT-23-6" },
    { logicalPinsByRef: { U5: ["VDD", "GND"] }, allowNetwork: false }
  );

  const gnd = resolved.resolution.pins.perPin.GND;
  assert.equal(gnd.real, true);
  assert.equal(gnd.pad, "pin2", "datasheet table: GND is pin 2 on SOT23-6");
  assert.equal(gnd.source, SOURCE.CURATED);
});

test("LP103SB6F VDD stays PIN_NOT_FOUND — the part genuinely has no VDD", async () => {
  // Its supply is `PS`, an internally generated rail. Mapping VDD to something
  // plausible would be exactly the guess this system forbids.
  const resolved = await resolveComponent(
    { ref_id: "U5", part_number: "LP103SB6F", part_class: "power", package: "SOT-23-6" },
    { logicalPinsByRef: { U5: ["VDD", "GND"] }, allowNetwork: false }
  );

  assert.equal(resolved.resolution.pins.perPin.VDD.real, false);
  assert.ok(resolved.errors.some((e) => e.code === "PIN_NOT_FOUND" && e.target === "U5.VDD"));
  assert.equal(
    resolved.resolution.pins.real,
    false,
    "one unmatched pin keeps the whole map unsafe to manufacture from"
  );
});

test("the LP103SB6F entry records its datasheet provenance", () => {
  const result = curatedPinout("LP103SB6F", "SOT-23-6");
  assert.ok(result.evidence.includes("LCSC C387729"), "datasheet source recorded");
  assert.match(result.evidence, /gate 2 score 1\.0/, "gate results recorded");
  assert.match(result.evidence, /Confirmed by a human/, "human confirmation recorded");
  // The near-miss reading must stay documented so it is not "corrected" later.
  assert.match(result.evidence, /naively reads GND=pin5/);
});
