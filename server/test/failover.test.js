/**
 * Provider failover / degraded mode (Phase 6).
 *
 * The load-bearing rule: a single-provider result NEVER auto-accepts, even with
 * every deterministic gate passing. That is not caution for its own sake — the
 * LP103SB6F near-miss produced exactly that shape (one extractor, all gates
 * passing, wrong answer). Gates verify internal consistency, not correctness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  comparePin,
  extractWithVerification,
  OUTCOME,
  VERIFICATION_MODE,
  isDegraded,
  DEGRADED_WARNING,
} from "../src/design/dualExtraction.js";

const PADS = ["pin1", "pin2", "pin3", "pin4", "pin5", "pin6"];

const claim = (pin, { passed = true } = {}) => ({
  logical_pin: "GND",
  physical_pin: pin,
  evidence: "GND   3   2   Ground.",
  gates: { structural: { pass: passed }, evidence: { pass: passed }, relevance: { pass: passed } },
  passed,
});
const ran = (claims) => ({ ok: true, status: claims.length ? "ok" : "declined", claims });
const down = (reason) => ({ ok: false, status: "provider_failure", reason, claims: [] });

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test("THE RULE: a gate-passing single-provider result does NOT auto-accept", () => {
  for (const mode of [VERIFICATION_MODE.GEMINI_ONLY, VERIFICATION_MODE.GROQ_ONLY]) {
    const a = mode === VERIFICATION_MODE.GEMINI_ONLY ? ran([claim("pin2")]) : down("quota");
    const b = mode === VERIFICATION_MODE.GEMINI_ONLY ? down("quota") : ran([claim("pin2")]);

    const result = comparePin("GND", a, b, mode);

    assert.notEqual(result.outcome, OUTCOME.AUTO_ACCEPTED, `${mode} must never auto-accept`);
    assert.equal(result.outcome, OUTCOME.NEEDS_REVIEW);
    assert.equal(result.degraded, true);
    assert.equal(result.degradedReason, "provider_outage");
    assert.equal(result.verification_mode, mode);
    // The proposal is still carried, so review has something to act on.
    assert.equal(result.physical_pin, "pin2");
  }
});

test("the degraded warning explains the evidentiary gap, not just 'lower confidence'", () => {
  const result = comparePin("GND", ran([claim("pin2")]), down("quota"), VERIFICATION_MODE.GEMINI_ONLY);
  assert.ok(result.warning);
  assert.match(result.warning, /NOT been independently reproduced/i);
  assert.match(result.warning, /consistency, not correctness/i);
  assert.match(result.warning, /LP103SB6F/);
});

test("review cause distinguishes provider outage from extractor conflict", () => {
  const degraded = comparePin("GND", ran([claim("pin2")]), down("quota"), VERIFICATION_MODE.GEMINI_ONLY);
  assert.equal(degraded.degradedReason, "provider_outage");

  const conflict = comparePin("GND", ran([claim("pin5")]), ran([claim("pin2")]), VERIFICATION_MODE.DUAL);
  assert.equal(conflict.degradedReason, "extractor_conflict");
  assert.match(conflict.reason, /DISAGREE/);
});

test("dual mode still auto-accepts on genuine independent agreement", () => {
  const result = comparePin("GND", ran([claim("pin2")]), ran([claim("pin2")]), VERIFICATION_MODE.DUAL);
  assert.equal(result.outcome, OUTCOME.AUTO_ACCEPTED);
  assert.equal(result.verification_mode, VERIFICATION_MODE.DUAL);
  assert.equal(result.degraded, undefined);
});

test("every result carries verification_mode, degraded or not", () => {
  const modes = [
    [ran([claim("pin2")]), ran([claim("pin2")]), VERIFICATION_MODE.DUAL],
    [ran([claim("pin2")]), down("x"), VERIFICATION_MODE.GEMINI_ONLY],
    [down("x"), ran([claim("pin2")]), VERIFICATION_MODE.GROQ_ONLY],
    [down("x"), down("y"), VERIFICATION_MODE.NONE],
  ];
  for (const [a, b, mode] of modes) {
    assert.equal(comparePin("GND", a, b, mode).verification_mode, mode);
  }
});

test("a degraded result that FAILS a gate is still review, not silent loss", () => {
  const result = comparePin(
    "GND",
    ran([claim("pin2", { passed: false })]),
    down("quota"),
    VERIFICATION_MODE.GEMINI_ONLY
  );
  assert.equal(result.outcome, OUTCOME.NEEDS_REVIEW);
  assert.equal(result.degraded, true);
});

test("BOTH providers down is NOT_ATTEMPTED, never PIN_NOT_FOUND", () => {
  const result = comparePin("GND", down("quota"), down("outage"), VERIFICATION_MODE.NONE);
  assert.equal(result.outcome, OUTCOME.NOT_ATTEMPTED);
  assert.notEqual(result.outcome, OUTCOME.NOT_FOUND);
});

test("degraded + no claim is NOT_FOUND — the extractor ran and found nothing", () => {
  const result = comparePin("GND", ran([]), down("quota"), VERIFICATION_MODE.GEMINI_ONLY);
  assert.equal(result.outcome, OUTCOME.NOT_FOUND);
  assert.equal(result.degraded, true);
});

// ---------------------------------------------------------------------------
// Failover orchestration
// ---------------------------------------------------------------------------

const fakeExtractor = (id, behaviour) => ({
  id,
  name: `fake-${id}`,
  call: async () => behaviour,
});
const proposes = (pin) => ({
  ok: true,
  parsed: { pins: [{ logical_pin: "GND", physical_pin: pin, evidence: "GND   3   2   Ground.", confidence: 0.9 }] },
});
const fails = (reason) => ({ ok: false, reason });

const runWith = (a, b, extra = {}) =>
  extractWithVerification({
    partNumber: "TEST",
    pkg: "SOT-23-6",
    neededPins: ["GND"],
    datasheetText: "Functional Pin Description GND   3   2   Ground.",
    footprintPads: PADS,
    extractors: [fakeExtractor("A", a), fakeExtractor("B", b)],
    ...extra,
  });

test("Extractor A down => B runs alone, mode GROQ_ONLY, no auto-accept", async () => {
  const result = await runWith(fails("HTTP 429"), proposes("pin2"));
  assert.equal(result.verification_mode, VERIFICATION_MODE.GROQ_ONLY);
  assert.equal(result.degraded, true);
  assert.equal(result.autoAccepted.length, 0, "degraded must never auto-accept");
  assert.equal(result.needsReview.length, 1);
  assert.ok(result.degradedWarning);
});

test("Extractor B down => mode GEMINI_ONLY, no auto-accept", async () => {
  const result = await runWith(proposes("pin2"), fails("HTTP 503"));
  assert.equal(result.verification_mode, VERIFICATION_MODE.GEMINI_ONLY);
  assert.equal(result.autoAccepted.length, 0);
  assert.equal(result.needsReview.length, 1);
});

test("both down => NONE, everything NOT_ATTEMPTED", async () => {
  const result = await runWith(fails("HTTP 429"), fails("HTTP 429"));
  assert.equal(result.verification_mode, VERIFICATION_MODE.NONE);
  assert.equal(result.notAttempted.length, 1);
  assert.equal(result.notFound.length, 0);
});

test("both up and agreeing => DUAL and auto-accept", async () => {
  const result = await runWith(proposes("pin2"), proposes("pin2"));
  assert.equal(result.verification_mode, VERIFICATION_MODE.DUAL);
  assert.equal(result.degraded, false);
  assert.equal(result.autoAccepted.length, 1);
});

test("B skipped by design (A had nothing) is NOT treated as an outage", async () => {
  // A ran fine and returned a claim that fails gates; B is skipped to save cost.
  // That is not a provider failure, so the mode must stay DUAL.
  const result = await runWith(
    { ok: true, parsed: { pins: [{ logical_pin: "GND", physical_pin: "pin99", evidence: "nope", confidence: 1 }] } },
    proposes("pin2")
  );
  assert.equal(result.verification_mode, VERIFICATION_MODE.DUAL);
  assert.equal(result.degraded, false);
});

test("a provider marked unavailable is skipped without being called", async () => {
  let called = false;
  const result = await extractWithVerification({
    partNumber: "TEST",
    pkg: "SOT-23-6",
    neededPins: ["GND"],
    datasheetText: "Functional Pin Description GND   3   2   Ground.",
    footprintPads: PADS,
    extractors: [
      fakeExtractor("A", proposes("pin2")),
      { id: "B", name: "fake-B", call: async () => { called = true; return proposes("pin2"); } },
    ],
    unavailable: { B: "quota exhausted" },
  });

  assert.equal(called, false, "a provider believed down must not be called");
  assert.equal(result.verification_mode, VERIFICATION_MODE.GEMINI_ONLY);
  assert.equal(result.autoAccepted.length, 0);
});

test("isDegraded classifies the modes correctly", () => {
  assert.equal(isDegraded(VERIFICATION_MODE.DUAL), false);
  assert.equal(isDegraded(VERIFICATION_MODE.NONE), false);
  assert.equal(isDegraded(VERIFICATION_MODE.GEMINI_ONLY), true);
  assert.equal(isDegraded(VERIFICATION_MODE.GROQ_ONLY), true);
  assert.ok(DEGRADED_WARNING.length > 0);
});
