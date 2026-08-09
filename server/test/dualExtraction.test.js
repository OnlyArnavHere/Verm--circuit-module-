/**
 * Dual-independent-extraction comparator (Phase 6).
 *
 * The live near-miss reconstruction lives in `scripts/verify-near-miss.js` (it
 * needs network + API keys). These tests pin the comparator's decision logic
 * deterministically, including the fail-safe when Extractor B is unavailable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { comparePin, extractWithVerification, OUTCOME } from "../src/design/dualExtraction.js";
import { normalizePinRef, gateStructural } from "../src/design/datasheetExtraction.js";

const PADS = ["pin1", "pin2", "pin3", "pin4", "pin5", "pin6"];

const claim = (pin, { passed = true } = {}) => ({
  logical_pin: "GND",
  physical_pin: pin,
  evidence: "GND   3   2   Ground.",
  gates: {
    structural: { pass: passed },
    evidence: { pass: passed, score: passed ? 1 : 0 },
  },
  passed,
});
const result = (claims) => ({ ok: true, claims });

// ---------------------------------------------------------------------------
// Comparator
// ---------------------------------------------------------------------------

test("auto-accepts only when both agree AND both passed both gates", () => {
  const outcome = comparePin("GND", result([claim("pin2")]), result([claim("pin2")]));
  assert.equal(outcome.outcome, OUTCOME.AUTO_ACCEPTED);
  assert.equal(outcome.physical_pin, "pin2");
});

test("THE NEAR-MISS: both pass both gates but disagree -> human review", () => {
  // Exactly the LP103SB6F case: pin5 from the package diagram, pin2 from the
  // per-package table. Both excerpts are genuinely in the datasheet.
  const outcome = comparePin("GND", result([claim("pin5")]), result([claim("pin2")]));

  assert.equal(outcome.outcome, OUTCOME.NEEDS_REVIEW);
  assert.notEqual(outcome.outcome, OUTCOME.AUTO_ACCEPTED);
  assert.match(outcome.reason, /DISAGREE/);
  assert.match(outcome.reason, /pin5/);
  assert.match(outcome.reason, /pin2/);
});

test("a gate failure on either side blocks auto-accept even when they agree", () => {
  for (const [a, b] of [
    [claim("pin2", { passed: false }), claim("pin2")],
    [claim("pin2"), claim("pin2", { passed: false })],
  ]) {
    const outcome = comparePin("GND", result([a]), result([b]));
    assert.equal(outcome.outcome, OUTCOME.NEEDS_REVIEW);
    assert.match(outcome.reason, /failed a deterministic gate/);
  }
});

test("FAIL-SAFE: an unavailable Extractor B can never auto-accept", () => {
  // Grok without credits returns ok:false with no claims. Agreement is then
  // impossible by construction, so nothing can slip through unverified.
  const outcome = comparePin(
    "GND",
    result([claim("pin2")]),
    { ok: false, reason: "no credits", claims: [] }
  );
  assert.equal(outcome.outcome, OUTCOME.NEEDS_REVIEW);
  assert.match(outcome.reason, /only one extractor/);
});

test("neither extractor returning the pin is NOT_FOUND, not agreement", () => {
  const outcome = comparePin("GND", result([]), result([]));
  assert.equal(outcome.outcome, OUTCOME.NOT_FOUND);
});

test("formatting differences are not treated as disagreement", () => {
  // "5" and "pin5" are the same pin; only substantive differences may block.
  const a = { ...claim("pin5"), physical_pin: normalizePinRef("5", PADS) };
  const b = claim("pin5");
  assert.equal(comparePin("GND", result([a]), result([b])).outcome, OUTCOME.AUTO_ACCEPTED);
});

// ---------------------------------------------------------------------------
// Pin-reference normalization (D-045)
// ---------------------------------------------------------------------------

test("normalizes the pin spellings models actually emit", () => {
  for (const raw of ["pin2", "PIN2", "2", "Pin 2", "pin_2"]) {
    assert.equal(normalizePinRef(raw, PADS), "pin2", `"${raw}" should resolve to pin2`);
  }
});

test("normalization never invents a pad that does not exist", () => {
  assert.equal(normalizePinRef("9", PADS), null);
  assert.equal(normalizePinRef("pin9", PADS), null);
  assert.equal(normalizePinRef("", PADS), null);
});

test("BGA ball ids pass through untouched", () => {
  const bga = ["A1", "B14", "T17"];
  assert.equal(normalizePinRef("A1", bga), "A1");
  assert.equal(normalizePinRef("a1", bga), "A1");
  assert.equal(normalizePinRef("C3", bga), null, "a ball not on the part is still rejected");
});

test("gate 1 reports the normalized pin so downstream compares like with like", () => {
  const gate = gateStructural({ physical_pin: "5" }, PADS);
  assert.equal(gate.pass, true);
  assert.equal(gate.normalizedPin, "pin5");
  assert.match(gate.reason, /normalized/);
});

// ---------------------------------------------------------------------------
// Blindness
// ---------------------------------------------------------------------------

test("Extractor B never receives Extractor A's proposal or evidence", async () => {
  const prompts = [];
  const fakeExtractor = (id, pin) => ({
    id,
    name: `fake-${id}`,
    call: async (prompt) => {
      prompts.push({ id, prompt });
      return {
        ok: true,
        parsed: {
          pins: [
            {
              logical_pin: "GND",
              physical_pin: pin,
              // Must be real datasheet text, or A fails gate 2 and B never runs.
              evidence: "GND   3   2   Ground.",
              confidence: 0.9,
            },
          ],
        },
      };
    },
  });

  await extractWithVerification({
    partNumber: "LP103SB6F",
    pkg: "SOT-23-6",
    neededPins: ["GND"],
    datasheetText: "Functional Pin Description GND   3   2   Ground.",
    footprintPads: PADS,
    extractors: [fakeExtractor("A", "pin2"), fakeExtractor("B", "pin2")],
  });

  const promptA = prompts.find((p) => p.id === "A")?.prompt;
  const promptB = prompts.find((p) => p.id === "B")?.prompt;
  assert.ok(promptB, "extractor B was called");

  // Blindness is structural: B receives the SAME prompt A did, built from the
  // datasheet alone. Identity proves nothing derived from A's answer reached B.
  // (Asserting "B's prompt lacks pin2" would be wrong — pin2 legitimately
  // appears in every prompt as part of the footprint's pad vocabulary.)
  assert.equal(promptB, promptA, "both extractors receive the identical prompt");
  assert.equal(
    promptB.includes("proposed"),
    false,
    "no proposal framing may leak into B's prompt"
  );
});
