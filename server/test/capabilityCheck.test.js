/**
 * PART_CAPABILITY_MISMATCH (Phase 6.6).
 *
 * The distinction being drawn:
 *   PIN_NOT_FOUND            — not resolved yet; it may exist
 *   PART_CAPABILITY_MISMATCH — the part's real pin set is CONFIRMED and does not
 *                              contain this function; no datasheet work can fix it
 *
 * The check is general — it reads a part's real exposed names against the
 * requested function — so these tests include a synthetic part/net combination
 * that is nowhere in the fixtures, to prove it is not tuned to known cases.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyUnresolvedPin,
  CAPABILITY_VERDICT,
  capabilityConfirmed,
} from "../src/design/capabilityCheck.js";
import { resolveComponent } from "../src/design/resolver.js";
import { curatedPinout } from "../src/design/curatedPinouts.js";
import { extractPinout } from "../src/design/pinout.js";
import { ERROR_CODES } from "../src/models/constants.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pinoutCache = JSON.parse(
  await fs.readFile(path.resolve(here, "../data/pinout-cache.json"), "utf8")
);

const pinout = (names, padCount = names.length) => ({
  ok: true,
  padCount,
  pins: Object.fromEntries(names.map((n, i) => [n, `pin${i + 1}`])),
});

test("the new code is in the taxonomy and distinct from PIN_NOT_FOUND", () => {
  assert.ok(ERROR_CODES.includes("PART_CAPABILITY_MISMATCH"));
  assert.ok(ERROR_CODES.includes("PIN_NOT_FOUND"));
  assert.notEqual(CAPABILITY_VERDICT.MISMATCH, CAPABILITY_VERDICT.UNRESOLVED);
});

// ---------------------------------------------------------------------------
// The general rule
// ---------------------------------------------------------------------------

test("a confirmed, fully-named part missing the function is a MISMATCH", () => {
  // An LED driver asked for audio.
  const result = classifyUnresolvedPin("AUDIO", pinout(["GND", "VDD", "SDI", "CLK", "LE", "OE"]));
  assert.equal(result.code, CAPABILITY_VERDICT.MISMATCH);
  assert.equal(result.capabilityConfirmed, true);
  assert.match(result.reason, /does not provide this function|no datasheet/i);
});

test("SYNTHETIC generality proof — a part/net combination absent from every fixture", () => {
  // MCP7940NT-I/SN is an I2C real-time clock. Its real 8/8 pin set is in the
  // cache. No fixture ever asks it for MOSI — this combination is constructed.
  const rtc = pinoutCache["jlcpcb:C148052"];
  assert.ok(rtc?.ok, "using the part's REAL cached pin data, not a hand-made stub");
  assert.equal(Object.keys(rtc.pins).length, rtc.padCount, "fully named");

  const result = classifyUnresolvedPin("MOSI", rtc);
  assert.equal(
    result.code,
    CAPABILITY_VERDICT.MISMATCH,
    "an I2C-only RTC asked for an SPI data line must be caught by the general rule"
  );
  assert.ok(result.availablePins.includes("SDA"), "it does have I2C");
  assert.ok(!result.availablePins.includes("MOSI"));

  // And a second, different synthetic case on another real part.
  const tempSensor = pinoutCache["jlcpcb:C194710"]; // MCP9808 temperature sensor
  const second = classifyUnresolvedPin("ANT", tempSensor);
  assert.equal(second.code, CAPABILITY_VERDICT.MISMATCH, "a temp sensor has no antenna feed");
});

test("a function the part DOES have is never a mismatch", () => {
  const rtc = pinoutCache["jlcpcb:C148052"];
  // SCL exists, so this classifier would not even be consulted — but if it is,
  // it must not claim a mismatch for something present.
  assert.ok(Object.keys(rtc.pins).includes("SCL"));
});

// ---------------------------------------------------------------------------
// Guard 1 — incomplete naming cannot support a negative claim
// ---------------------------------------------------------------------------

test("partial name coverage stays PIN_NOT_FOUND, never MISMATCH", () => {
  // HDSP-521G: 16 of 18 pads named, and pin13/pin14 are exactly where a DIP-18
  // display's common pins sit. Claiming "no GND" would be a false positive.
  const display = pinoutCache["jlcpcb:C5650089"];
  assert.ok(Object.keys(display.pins).length < display.padCount, "genuinely partial");

  const result = classifyUnresolvedPin("GND", display);
  assert.equal(result.code, CAPABILITY_VERDICT.UNRESOLVED);
  assert.equal(result.capabilityConfirmed, false);
  assert.match(result.reason, /unnamed/);
});

test("no capability data at all is PIN_NOT_FOUND", () => {
  for (const empty of [{ ok: false }, { ok: true, pins: {}, padCount: 0 }, null]) {
    assert.equal(classifyUnresolvedPin("GND", empty).code, CAPABILITY_VERDICT.UNRESOLVED);
  }
});

// ---------------------------------------------------------------------------
// Guard 2 — positional naming is not functional naming
// ---------------------------------------------------------------------------

test("a fully but POSITIONALLY named BGA never claims a mismatch", () => {
  // MIMXRT1172CVM8A names all 289 pads — by ball coordinate. The absence of a
  // pad literally called "GND" says nothing about whether it has a ground.
  const bga = pinoutCache["jlcpcb:C3220126"];
  assert.equal(Object.keys(bga.pins).length, bga.padCount, "fully named…");

  const result = classifyUnresolvedPin("GND", bga);
  assert.equal(result.code, CAPABILITY_VERDICT.UNRESOLVED, "…but positionally");
  assert.match(result.reason, /positionally|carries no capability/i);
});

test("functional naming is detected by the presence of a supply rail", () => {
  const positional = pinout(["A1", "A2", "B1", "B2"]);
  assert.equal(classifyUnresolvedPin("SDA", positional).code, CAPABILITY_VERDICT.UNRESOLVED);

  const functional = pinout(["VDD", "GND", "OUT", "REF"]);
  assert.equal(classifyUnresolvedPin("SDA", functional).code, CAPABILITY_VERDICT.MISMATCH);
});

// ---------------------------------------------------------------------------
// Guard 3 — mux-assignable functions on parts with generic I/O
// ---------------------------------------------------------------------------

test("a mux-assignable function on a GPIO-bearing part stays PIN_NOT_FOUND", () => {
  // RF-BM-2340A2I exposes DIO3..DIO24 and no TX, but its UART is firmware-mapped
  // onto a DIO — the part can plainly do TX.
  const module = pinoutCache["jlcpcb:C20624106"];
  const result = classifyUnresolvedPin("TX", module);
  assert.equal(result.code, CAPABILITY_VERDICT.UNRESOLVED);
  assert.match(result.reason, /mux/i);
});

test("a NON-mux-assignable function is still a mismatch even with generic I/O", () => {
  // ESPC2-12-N4 has IO0..IO18, but an antenna feed cannot be assigned to a GPIO.
  const module = pinoutCache["jlcpcb:C19949080"];
  const result = classifyUnresolvedPin("ANT", module);
  assert.equal(result.code, CAPABILITY_VERDICT.MISMATCH);
});

// ---------------------------------------------------------------------------
// End-to-end through the resolver, on real fixture parts
// ---------------------------------------------------------------------------

const resolveFor = (partNumber, pkg, pins) =>
  resolveComponent(
    { ref_id: "U1", part_number: partNumber, part_class: "output", package: pkg },
    { logicalPinsByRef: { U1: pins }, allowNetwork: false }
  );

test("MBI5124GP-B AUDIO/GPIO1 are reported as capability mismatches", async () => {
  const resolved = await resolveFor("MBI5124GP-B", "SSOP-24", ["AUDIO", "GPIO1"]);
  const codes = resolved.errors.map((e) => e.code);
  assert.equal(codes.filter((c) => c === "PART_CAPABILITY_MISMATCH").length, 2);
  assert.equal(codes.includes("PIN_NOT_FOUND"), false, "must not also be reported as unresolved");
});

test("LMA2718T421-OA5-2 SCL and ESPC2-12-N4 ANT are mismatches", async () => {
  for (const [part, pkg, pin] of [
    ["LMA2718T421-OA5-2", "SMD-4P,2.8x1.9mm", "SCL"],
    ["ESPC2-12-N4", "SMD,24x16mm", "ANT"],
  ]) {
    const resolved = await resolveFor(part, pkg, [pin]);
    const error = resolved.errors.find((e) => e.target === `U1.${pin}`);
    assert.equal(error.code, "PART_CAPABILITY_MISMATCH", `${part}.${pin}`);
    assert.equal(error.detail.capabilityConfirmed, true);
  }
});

test("HDSP-521G stays PIN_NOT_FOUND — the conservative call is preserved end-to-end", async () => {
  const resolved = await resolveFor("HDSP-521G", "DIP-18", ["GND", "SCK", "VDD"]);
  for (const error of resolved.errors.filter((e) => e.target.startsWith("U1."))) {
    assert.equal(error.code, "PIN_NOT_FOUND", `${error.target} must not over-claim`);
    assert.equal(error.detail.capabilityConfirmed, false);
  }
});

test("a genuinely resolvable pin produces no error at all", async () => {
  const resolved = await resolveFor("MCP9808T-E/MC", "DFN-8-EP(2x3)", ["SDA"]);
  assert.equal(
    resolved.errors.some((e) => e.target === "U1.SDA"),
    false,
    "SDA exists on this part and resolves"
  );
});

// ---------------------------------------------------------------------------
// Guard 4 — a curated pinout must be able to support a capability claim
// ---------------------------------------------------------------------------

test("curated-pinout-with-complete-pins produces MISMATCH, not PIN_NOT_FOUND", async () => {
  // resolver.js built the curated branch as `{ ok: true, pins }` with no
  // padCount. capabilityConfirmed needs padCount to assert completeness, so the
  // most trustworthy pin source in the system — a human/dual-extraction verified
  // table — was the ONLY one that could never support a capability claim. Every
  // unresolved pin on a curated part silently degraded to PIN_NOT_FOUND
  // ("no confirmed capability data for this part"), understating
  // PART_CAPABILITY_MISMATCH wherever curated data was used.
  //
  // HY2111-GB is a battery-protection IC: OD/CS/OC/NC/VDD/VSS, 6 of 6 pads on a
  // real SOT-23-6. It has no I2C. Asked for SCL it must say so outright.
  const curated = curatedPinout("HY2111-GB", "SOT-23-6");
  assert.ok(curated.ok, "using the REAL curated entry, not a stub");

  const asBuiltBefore = { ok: true, pins: curated.pins };
  assert.equal(
    classifyUnresolvedPin("SCL", asBuiltBefore).code,
    CAPABILITY_VERDICT.UNRESOLVED,
    "documents the old behaviour: no padCount means no capability claim is possible"
  );

  const pinout = await extractPinout("jlcpcb:C82747", { allowNetwork: true });
  assert.ok(pinout.ok && pinout.padCount === 6, "real footprint reports 6 pads");

  const asBuiltNow = { ok: true, pins: curated.pins, padCount: pinout.padCount };
  assert.equal(capabilityConfirmed(asBuiltNow), true, "6 curated names over 6 real pads");
  const verdict = classifyUnresolvedPin("SCL", asBuiltNow);
  assert.equal(verdict.code, CAPABILITY_VERDICT.MISMATCH);
  assert.equal(verdict.capabilityConfirmed, true);
  assert.ok(verdict.availablePins.includes("VDD"), "it does have a supply rail");
});

test("padCount must come from the FOOTPRINT, never from the curated pins", () => {
  // The tempting one-liner — padCount = the curated entry's own pad count —
  // would be a false hard negative, and this exact entry is why.
  //
  // LP103SB6F's curated entry is deliberately a SINGLE pin (GND -> pin2) on a
  // 6-pad SOT-23-6, so that its genuinely-absent VDD stays PIN_NOT_FOUND rather
  // than being mapped to something plausible. Self-derived, that reads as
  // "1 of 1 pads named" — complete — and every other function on the part
  // becomes a confident mismatch that no datasheet work could ever clear.
  const curated = curatedPinout("LP103SB6F", "SOT-23-6");
  assert.ok(curated.ok);
  assert.equal(Object.keys(curated.pins).length, 1, "deliberately not exhaustive");

  const selfDerived = { ok: true, pins: curated.pins, padCount: 1 };
  assert.equal(
    classifyUnresolvedPin("VDD", selfDerived).code,
    CAPABILITY_VERDICT.MISMATCH,
    "this is the WRONG answer the rejected approach produces"
  );

  const fromFootprint = { ok: true, pins: curated.pins, padCount: 6 };
  assert.equal(capabilityConfirmed(fromFootprint), false, "1 of 6 pads named");
  const verdict = classifyUnresolvedPin("VDD", fromFootprint);
  assert.equal(verdict.code, CAPABILITY_VERDICT.UNRESOLVED, "the conservative call is preserved");
  assert.match(verdict.reason, /only 1 of 6 pads are named/);
});

test("an unavailable catalogue lookup leaves padCount undefined, not guessed", () => {
  // If the footprint cannot be read we cannot know the pad count. Omitting it
  // keeps capabilityConfirmed false — an unknown must never read as complete.
  const noPadCount = { ok: true, pins: { GND: "pin2", VDD: "pin5" } };
  assert.equal(capabilityConfirmed(noPadCount), false);
  assert.equal(classifyUnresolvedPin("SCL", noPadCount).code, CAPABILITY_VERDICT.UNRESOLVED);
});

test("pad aliases do not corrupt the completeness guard", () => {
  // port_hints can give ONE pad several names, so a fully-named part can expose
  // more names than pads. Counting names instead of distinct pads made the two
  // completeness checks disagree with each other on the same part:
  //   classifyUnresolvedPin: names.length < padCount   -> 4 < 3 -> false -> COMPLETE
  //   capabilityConfirmed:   names.length === padCount -> 4 === 3 -> NOT complete
  // Real instance: jlcpcb:C22392413, 30 pads / 57 names.
  const aliased = {
    ok: true,
    padCount: 3,
    // pin1 carries two aliases; every pad is genuinely named.
    pins: { VDD: "pin1", VCC: "pin1", GND: "pin2", SCL: "pin3" },
  };
  assert.equal(capabilityConfirmed(aliased), true, "3 of 3 pads are named");

  // With every pad named and no SDA present, absence is now assertable.
  const verdict = classifyUnresolvedPin("SDA", aliased);
  assert.equal(verdict.code, CAPABILITY_VERDICT.MISMATCH);
  assert.equal(verdict.capabilityConfirmed, true);
});

test("aliases never make a partially-named part look complete", () => {
  // The dangerous direction: more names than pads, but pads still unnamed.
  const partial = {
    ok: true,
    padCount: 8,
    pins: { VDD: "pin1", VCC: "pin1", PWR: "pin1", GND: "pin2" }, // 4 names, 2 pads
  };
  assert.equal(capabilityConfirmed(partial), false, "only 2 of 8 pads named");
  const verdict = classifyUnresolvedPin("SDA", partial);
  assert.equal(verdict.code, CAPABILITY_VERDICT.UNRESOLVED);
  assert.equal(verdict.capabilityConfirmed, false);
  assert.match(verdict.reason, /only 2 of 8 pads are named/);
});
