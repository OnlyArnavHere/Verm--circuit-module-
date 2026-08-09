/**
 * Semantic target verification (Phase 8).
 *
 * The gap: DRC validates geometry, so moving the WRONG component to a perfectly
 * legal position passes every existing check. Nothing downstream can tell that
 * the regulator moved when the user said "the BLE module".
 *
 * These tests use the REAL smart_dustbin components and construct genuine
 * misidentifications, rather than asserting the mechanism exists.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyTarget, inferReferencedClasses, TARGET_VERDICT } from "../src/design/targetCheck.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const upstream = JSON.parse(
  await fs.readFile(path.resolve(here, "../../test-fixtures/smart_dustbin.json"), "utf8")
);
const components = upstream.components;
// U1 processing, U2 sensor, U3 communication, U4 output, U5/U6 power, U7 storage

// ---------------------------------------------------------------------------
// The constructed mismatch — the case this exists for
// ---------------------------------------------------------------------------

test("CONSTRUCTED MISMATCH: 'the BLE module' resolved to the power regulator is caught", () => {
  // U5 is TP4110, a battery charger. Moving it is geometrically valid, so DRC
  // would pass cleanly and the wrong part would ship silently.
  const result = verifyTarget("move the BLE module closer to the edge", "U5", components);

  assert.equal(result.verdict, TARGET_VERDICT.MISMATCH);
  assert.equal(result.ok, false);
  assert.equal(result.targetClass, "power");
  assert.deepEqual(result.expectedClasses, ["communication"]);
  // The message must name both what was said and what was actually targeted.
  assert.match(result.message, /ble/i);
  assert.match(result.message, /U5/);
  assert.match(result.message, /power/);
  // And point at the component the user probably meant.
  assert.ok(result.candidates.some((c) => c.startsWith("U3")), "suggests U3");
});

test("a second constructed mismatch, different classes, same detection", () => {
  const result = verifyTarget("shift the memory chip away from the antenna", "U1", components);
  assert.equal(result.verdict, TARGET_VERDICT.MISMATCH);
  assert.equal(result.targetClass, "processing");
  assert.ok(result.expectedClasses.includes("storage"));
  assert.ok(result.candidates.some((c) => c.startsWith("U7")));
});

test("naming one component while targeting another is a mismatch", () => {
  // The user said U7 outright; the interpreter picked U3.
  const result = verifyTarget("move U7 to the top edge", "U3", components);
  assert.equal(result.verdict, TARGET_VERDICT.MISMATCH);
  assert.deepEqual(result.namedInstead, ["U7"]);
});

test("naming a part number while targeting another is a mismatch", () => {
  const result = verifyTarget("move the TP4110 to the left", "U3", components);
  assert.equal(result.verdict, TARGET_VERDICT.MISMATCH);
  assert.ok(result.namedInstead.includes("U5"));
});

// ---------------------------------------------------------------------------
// It must not cry wolf
// ---------------------------------------------------------------------------

test("the correct target passes cleanly", () => {
  const result = verifyTarget("move the BLE module closer to the edge", "U3", components);
  assert.equal(result.verdict, TARGET_VERDICT.CONSISTENT);
  assert.equal(result.ok, true);
});

test("an explicitly named ref_id is never second-guessed", () => {
  // Even though "power" appears and U3 is not power, the user named U3.
  const result = verifyTarget("move U3 away from the power section", "U3", components);
  assert.equal(result.verdict, TARGET_VERDICT.EXPLICIT);
  assert.equal(result.ok, true);
});

test("a request with no component description is UNVERIFIABLE, not a mismatch", () => {
  const result = verifyTarget("move it down 5mm", "U3", components);
  assert.equal(result.verdict, TARGET_VERDICT.UNVERIFIABLE);
  assert.equal(result.ok, true, "no evidence is not evidence of a problem");
});

test("wording that fits several components is AMBIGUOUS, not a mismatch", () => {
  // U5 and U6 are both power-class; "the regulator" does not distinguish them.
  const result = verifyTarget("move the power regulator to the left edge", "U5", components);
  assert.equal(result.verdict, TARGET_VERDICT.AMBIGUOUS);
  assert.equal(result.ok, true, "the target is plausible, just not uniquely implied");
  assert.equal(result.candidates.length, 2);
});

test("terms match as whole words, not substrings", () => {
  // "led" must not fire inside "handled"; "mic" must not fire inside "microphone"
  // being absent entirely.
  const classes = inferReferencedClasses("the board should be handled carefully");
  assert.equal(classes.has("output"), false, '"handled" must not match "led"');
});

test("an unknown target ref_id is reported rather than ignored", () => {
  const result = verifyTarget("move the BLE module", "U99", components);
  assert.equal(result.verdict, TARGET_VERDICT.MISMATCH);
  assert.match(result.message, /not a component/);
});

// ---------------------------------------------------------------------------
// Vocabulary coverage across all eight classes
// ---------------------------------------------------------------------------

test("each part_class in the fixtures is reachable from natural wording", () => {
  const byClass = {
    processing: "move the microcontroller",
    sensor: "move the temperature sensor",
    communication: "move the wifi antenna",
    output: "move the led display driver",
    power: "move the battery charger",
    storage: "move the flash memory",
  };
  for (const [partClass, phrase] of Object.entries(byClass)) {
    const inferred = inferReferencedClasses(phrase);
    assert.ok(inferred.has(partClass), `"${phrase}" should imply ${partClass}`);
  }
});
