/**
 * Key-level rotation (Phase 6).
 *
 * The property that matters: rotation is a CREDENTIAL concern. Whichever key
 * served a request, the gates and the auto-accept rule are unchanged, and
 * `verification_mode` stays DUAL. Only exhausting every tier degrades the run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  callWithRotation,
  isRotatableFailure,
  parseJsonLoose,
} from "../src/design/extractorTiers.js";
import { extractWithVerification, VERIFICATION_MODE, OUTCOME } from "../src/design/dualExtraction.js";

const PADS = ["pin1", "pin2", "pin3", "pin4", "pin5", "pin6"];

const tier = (label, behaviour) => {
  const calls = { count: 0 };
  return {
    label,
    provider: label.split("#")[0],
    calls,
    call: async () => {
      calls.count += 1;
      return behaviour;
    },
  };
};
const quota = (label) => ({ ok: false, status: 429, reason: `${label} quota exhausted` });
const good = () => ({ ok: true, parsed: { pins: [] } });

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

test("an exhausted key rotates to the next key for the same provider", async () => {
  const first = tier("gemini#1", quota("gemini#1"));
  const second = tier("gemini#2", good());

  const result = await callWithRotation([first, second], "prompt");

  assert.equal(result.ok, true);
  assert.equal(result.servedBy, "gemini#2");
  assert.equal(first.calls.count, 1, "the exhausted key was tried");
  assert.equal(second.calls.count, 1, "then rotated to the next");
});

test("rotation continues across providers within one extractor's chain", async () => {
  const chain = [tier("groq#1", quota("groq#1")), tier("groq#2", quota("groq#2")), tier("ollama-cloud", good())];
  const result = await callWithRotation(chain, "prompt");

  assert.equal(result.ok, true);
  assert.equal(result.servedBy, "ollama-cloud");
  assert.equal(result.tiersTried.length, 3);
});

test("only after EVERY tier is exhausted is the extractor a provider failure", async () => {
  const chain = [tier("groq#1", quota("a")), tier("groq#2", quota("b"))];
  const result = await callWithRotation(chain, "prompt");

  assert.equal(result.ok, false);
  assert.equal(result.servedBy, null);
  assert.match(result.reason, /all 2 credential tier\(s\) exhausted/);
});

test("a non-rotatable failure does NOT burn the remaining keys", async () => {
  // A malformed request fails identically on every credential; rotating would
  // just waste quota that a later part may need.
  const first = tier("gemini#1", { ok: false, status: 400, reason: "invalid request" });
  const second = tier("gemini#2", good());

  const result = await callWithRotation([first, second], "prompt");

  assert.equal(result.ok, false);
  assert.equal(second.calls.count, 0, "the second key must not be spent on a bad request");
});

test("rotatable failures are quota/rate/size, not everything", () => {
  for (const failure of [
    { status: 429 },
    { status: 413 },
    { status: 402 },
    { quotaExhausted: true },
    { reason: "Request too large for model ... tokens per minute (TPM)" },
    { reason: "You exceeded your current quota" },
  ]) {
    assert.equal(isRotatableFailure(failure), true, JSON.stringify(failure));
  }
  for (const failure of [{ status: 400, reason: "bad request" }, { reason: "unparseable JSON" }]) {
    assert.equal(isRotatableFailure(failure), false, JSON.stringify(failure));
  }
});

test("no configured credentials is reported, not silently treated as success", async () => {
  const result = await callWithRotation([], "prompt");
  assert.equal(result.ok, false);
  assert.match(result.reason, /no credentials configured/);
});

// ---------------------------------------------------------------------------
// Rotation must not change the verification contract
// ---------------------------------------------------------------------------

const extractorWith = (id, responses) => {
  let index = 0;
  return {
    id,
    name: `fake-${id}`,
    call: async () => responses[Math.min(index++, responses.length - 1)],
  };
};
const proposes = (pin, servedBy) => ({
  ok: true,
  servedBy,
  parsed: {
    pins: [{ logical_pin: "GND", physical_pin: pin, evidence: "GND   3   2   Ground.", confidence: 0.9 }],
  },
});

test("a result served by a SECONDARY key still counts as DUAL and can auto-accept", async () => {
  const result = await extractWithVerification({
    partNumber: "TEST",
    pkg: "SOT-23-6",
    neededPins: ["GND"],
    datasheetText: "Functional Pin Description GND   3   2   Ground.",
    footprintPads: PADS,
    extractors: [
      extractorWith("A", [proposes("pin2", "gemini#2")]), // rotated key
      extractorWith("B", [proposes("pin2", "ollama-cloud")]), // rotated provider
    ],
  });

  assert.equal(
    result.verification_mode,
    VERIFICATION_MODE.DUAL,
    "which credential served a request must not affect verification_mode"
  );
  assert.equal(result.degraded, false);
  assert.equal(result.autoAccepted.length, 1, "rotation does not weaken the evidence");
});

test("the credential that served each extractor is recorded in provenance", async () => {
  const result = await extractWithVerification({
    partNumber: "TEST",
    pkg: "SOT-23-6",
    neededPins: ["GND"],
    datasheetText: "Functional Pin Description GND   3   2   Ground.",
    footprintPads: PADS,
    extractors: [
      extractorWith("A", [proposes("pin2", "gemini#2")]),
      extractorWith("B", [proposes("pin2", "groq#1")]),
    ],
  });

  assert.equal(result.extractorA.servedBy, "gemini#2");
  assert.equal(result.extractorB.servedBy, "groq#1");
});

test("exhausting one extractor's whole chain degrades, and still never auto-accepts", async () => {
  const result = await extractWithVerification({
    partNumber: "TEST",
    pkg: "SOT-23-6",
    neededPins: ["GND"],
    datasheetText: "Functional Pin Description GND   3   2   Ground.",
    footprintPads: PADS,
    extractors: [
      extractorWith("A", [proposes("pin2", "gemini#1")]),
      extractorWith("B", [{ ok: false, reason: "all 2 credential tier(s) exhausted" }]),
    ],
  });

  assert.equal(result.verification_mode, VERIFICATION_MODE.GEMINI_ONLY);
  assert.equal(result.autoAccepted.length, 0);
  assert.equal(result.needsReview[0].outcome, OUTCOME.NEEDS_REVIEW);
});

// ---------------------------------------------------------------------------
// Lenient JSON parsing (Ollama/gpt-oss sometimes fences its output)
// ---------------------------------------------------------------------------

test("JSON is parsed through code fences and surrounding prose", () => {
  assert.deepEqual(parseJsonLoose('{"pins":[]}'), { pins: [] });
  assert.deepEqual(parseJsonLoose('```json\n{"pins":[]}\n```'), { pins: [] });
  assert.deepEqual(parseJsonLoose('Here you go:\n{"pins":[]}\nhope that helps'), { pins: [] });
  assert.equal(parseJsonLoose("not json at all"), null);
});
