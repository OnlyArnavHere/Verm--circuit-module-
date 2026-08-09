/**
 * Phase 6 Group C pilot — proof that the two deterministic gates actually catch
 * a deliberately-bad extraction.
 *
 * Same rigor as the pinLabels / traceCount bug proofs: the failure is
 * constructed and asserted, not assumed. Gates are pure deterministic code, so
 * they are provable without a live Gemini call or a live datasheet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  gateStructural,
  gateEvidence,
  extractPinsFromDatasheet,
  extractDatasheetUrls,
  buildPrompt,
  geminiConfigured,
  EXTRACTION_STATUS,
} from "../src/design/datasheetExtraction.js";

/** Stand-in for real datasheet text (LP103SB6F is a SOT-23-6 protection IC). */
const DATASHEET_TEXT = `
LP103SB6F Lithium Battery Protection IC
Pin Configuration and Functions
Pin 1  VDD   Power supply input, connect to battery positive terminal
Pin 2  CS    Current sense input for overcurrent detection
Pin 3  OC    Overcurrent detection output
Pin 4  NC    No internal connection
Pin 5  OD    Overdischarge FET gate drive output
Pin 6  VSS   Ground reference, connect to battery negative terminal
Absolute Maximum Ratings apply over the operating temperature range.
`;

const PADS = ["pin1", "pin2", "pin3", "pin4", "pin5", "pin6"];

// ---------------------------------------------------------------------------
// Gate 1 — structural
// ---------------------------------------------------------------------------

test("GATE 1 rejects a pin that does not exist on the compiled footprint", () => {
  // A 6-pad SOT-23-6 cannot have a pin 7, however confident the model is.
  const result = gateStructural({ logical_pin: "VDD", physical_pin: "pin7" }, PADS);
  assert.equal(result.pass, false);
  assert.match(result.reason, /does not exist on the compiled footprint/);
});

test("GATE 1 rejects a BGA-style ball on a SOT-23 footprint", () => {
  assert.equal(gateStructural({ physical_pin: "A1" }, PADS).pass, false);
});

test("GATE 1 accepts a pin that really is on the footprint", () => {
  const result = gateStructural({ logical_pin: "VDD", physical_pin: "pin1" }, PADS);
  assert.equal(result.pass, true);
});

test("GATE 1 rejects a missing physical_pin rather than passing it through", () => {
  assert.equal(gateStructural({ logical_pin: "VDD" }, PADS).pass, false);
  assert.equal(gateStructural({ physical_pin: "" }, PADS).pass, false);
});

// ---------------------------------------------------------------------------
// Gate 2 — anti-hallucination
// ---------------------------------------------------------------------------

test("GATE 2 rejects fabricated evidence that is not in the datasheet", () => {
  // Plausible-sounding, structurally valid, and entirely invented.
  const claim = {
    logical_pin: "SDA",
    physical_pin: "pin2",
    evidence: "Pin 2 SDA I2C serial data line with internal pull-up resistor",
    confidence: 0.98,
  };
  const result = gateEvidence(claim, DATASHEET_TEXT);
  assert.equal(result.pass, false, "invented evidence must be rejected");
  assert.match(result.reason, /treated as hallucinated/);
});

test("GATE 2 accepts near-verbatim evidence despite whitespace/case noise", () => {
  const claim = {
    physical_pin: "pin6",
    evidence: "Pin  6   VSS  Ground REFERENCE, connect to battery negative terminal",
  };
  const result = gateEvidence(claim, DATASHEET_TEXT);
  assert.equal(result.pass, true, "PDF extraction artefacts must not cause false rejection");
  assert.ok(result.score >= 0.8);
});

test("GATE 2 rejects a paraphrase, even when factually correct", () => {
  // True statement, but not an excerpt — the gate demands source text.
  const claim = {
    physical_pin: "pin6",
    evidence: "The sixth terminal serves as the negative supply connection point",
  };
  assert.equal(gateEvidence(claim, DATASHEET_TEXT).pass, false);
});

test("GATE 2 rejects empty or trivially short evidence", () => {
  for (const evidence of ["", "   ", "VSS"]) {
    assert.equal(gateEvidence({ evidence }, DATASHEET_TEXT).pass, false);
  }
});

// ---------------------------------------------------------------------------
// Confidence is not a gate
// ---------------------------------------------------------------------------

test("a self-reported confidence of 1.0 does NOT rescue a failing claim", () => {
  const claim = {
    logical_pin: "SDA",
    physical_pin: "pin9",
    evidence: "Pin 9 SDA is the I2C data pin",
    confidence: 1.0,
  };
  assert.equal(gateStructural(claim, PADS).pass, false);
  assert.equal(gateEvidence(claim, DATASHEET_TEXT).pass, false);
});

// ---------------------------------------------------------------------------
// End-to-end orchestration
// ---------------------------------------------------------------------------

/** Fake origin: serves a part-detail page, a PDF, and a Gemini response. */
function fakeFetch({ pins, pdfText = DATASHEET_TEXT, pageOk = true, pdfOk = true }) {
  const calls = { page: 0, pdf: 0, gemini: 0 };
  const pdfBuffer = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(pdfText)]);

  const impl = async (url, init) => {
    if (String(url).includes("generativelanguage")) {
      calls.gemini += 1;
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ pins }) }] } }],
        }),
        { status: 200 }
      );
    }
    if (String(url).includes("partdetail")) {
      calls.page += 1;
      if (!pageOk) return new Response("nope", { status: 403 });
      return new Response(
        `<a href="https://jlc-prod-smt.oss.aliyuncs.com/smtDataManualFile/1-C387729.pdf?x-oss-signature=abc">ds</a>`,
        { status: 200 }
      );
    }
    calls.pdf += 1;
    if (!pdfOk) return new Response("denied", { status: 403 });
    return new Response(pdfBuffer, { status: 200 });
  };
  impl.calls = calls;
  return impl;
}

/**
 * The fake origin serves plain text behind a %PDF header rather than a real
 * PDF, so PDF parsing is injected out. The gates and orchestration under test
 * are unaffected by how the bytes became text.
 */
const fakePdfToText = async (buffer) =>
  buffer.subarray("%PDF-1.4\n".length).toString("utf8");

const baseArgs = {
  partNumber: "LP103SB6F",
  lcsc: "C387729",
  package: "SOT-23-6",
  neededPins: ["VDD", "GND"],
  footprintPads: PADS,
  persist: false,
  pdfToTextImpl: fakePdfToText,
  apiKey: "test-key-not-real",
};

test("NO DATASHEET => PIN_NOT_FOUND, and Gemini is never called", async () => {
  const fetchImpl = fakeFetch({ pins: [], pageOk: false });
  const result = await extractPinsFromDatasheet({ ...baseArgs, fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.code, "PIN_NOT_FOUND");
  assert.equal(result.geminiCalled, false, "a model call without a datasheet is forbidden");
  assert.equal(fetchImpl.calls.gemini, 0, "the model endpoint must not be contacted");
});

test("datasheet link found but download fails => PIN_NOT_FOUND, no model call", async () => {
  const fetchImpl = fakeFetch({ pins: [], pdfOk: false });
  const result = await extractPinsFromDatasheet({ ...baseArgs, fetchImpl });

  assert.equal(result.code, "PIN_NOT_FOUND");
  assert.equal(result.geminiCalled, false);
  assert.equal(fetchImpl.calls.gemini, 0);
});

test("a good extraction reaches 'proposed' — NOT trusted, awaiting a human", async () => {
  const fetchImpl = fakeFetch({
    pins: [
      {
        logical_pin: "GND",
        physical_pin: "pin6",
        evidence: "Pin 6  VSS   Ground reference, connect to battery negative terminal",
        confidence: 0.9,
      },
    ],
  });
  const result = await extractPinsFromDatasheet({ ...baseArgs, fetchImpl });

  assert.equal(result.ok, true);
  const [pin] = result.results;
  assert.equal(pin.gates.structural.pass, true);
  assert.equal(pin.gates.evidence.pass, true);
  assert.equal(
    pin.status,
    EXTRACTION_STATUS.PROPOSED,
    "passing both gates yields 'proposed', never 'verified'"
  );
  assert.equal(result.record.confirmedBy, null, "no human has confirmed it");
});

test("THE DELIBERATELY-BAD EXTRACTION: both failure modes are caught", async () => {
  const fetchImpl = fakeFetch({
    pins: [
      // Bad #1: pin does not exist on a 6-pad footprint.
      {
        logical_pin: "VDD",
        physical_pin: "pin12",
        evidence: "Pin 1  VDD   Power supply input, connect to battery positive terminal",
        confidence: 0.99,
      },
      // Bad #2: real pin, invented evidence.
      {
        logical_pin: "GND",
        physical_pin: "pin6",
        evidence: "Pin 6 GND is the I2C ground return for the SDA and SCL bus lines",
        confidence: 0.97,
      },
    ],
  });
  const result = await extractPinsFromDatasheet({ ...baseArgs, fetchImpl });

  const [structuralFail, evidenceFail] = result.results;

  assert.equal(structuralFail.status, EXTRACTION_STATUS.REJECTED);
  assert.equal(structuralFail.gates.structural.pass, false, "gate 1 must catch pin12");

  assert.equal(evidenceFail.status, EXTRACTION_STATUS.REJECTED);
  assert.equal(evidenceFail.gates.structural.pass, true, "pin6 really exists...");
  assert.equal(evidenceFail.gates.evidence.pass, false, "...but gate 2 must catch the invention");

  assert.equal(
    result.results.filter((r) => r.status === EXTRACTION_STATUS.PROPOSED).length,
    0,
    "no bad claim may reach 'proposed'"
  );
});

test("gate results and provenance are recorded for audit", async () => {
  const fetchImpl = fakeFetch({
    pins: [
      {
        logical_pin: "GND",
        physical_pin: "pin6",
        evidence: "Pin 6  VSS   Ground reference, connect to battery negative terminal",
        confidence: 0.42,
      },
    ],
  });
  const { record } = await extractPinsFromDatasheet({ ...baseArgs, fetchImpl });

  assert.ok(record.datasheetUrl, "datasheet URL recorded");
  assert.ok(record.extractedAt);
  assert.equal(record.results[0].reportedConfidence, 0.42, "confidence stored as audit data");
  assert.ok(record.results[0].gates.structural.reason);
  assert.ok(record.results[0].gates.evidence.reason);
  // Low reported confidence did not block a claim that passed both real gates.
  assert.equal(record.results[0].status, EXTRACTION_STATUS.PROPOSED);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test("datasheet links are extracted, signed URLs preferred", () => {
  const html =
    `x https://a.com/smtDataManualFile/1-C1.pdf y ` +
    `https://a.com/smtDataManualFile/2-C1.pdf?x-oss-signature=zzz z`;
  const urls = extractDatasheetUrls(html);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /x-oss-signature/, "signed URL must be tried first");
});

test("the prompt asks for only the needed pins and demands verbatim evidence", () => {
  const prompt = buildPrompt({
    partNumber: "LP103SB6F",
    package: "SOT-23-6",
    neededPins: ["VDD", "GND"],
    datasheetText: DATASHEET_TEXT,
  });
  assert.match(prompt, /ONLY these logical functions: VDD, GND/);
  assert.match(prompt, /Do not return a full pinout/);
  assert.match(prompt, /near-verbatim/);
});

test("geminiConfigured reports honestly whether a real call is possible", () => {
  assert.equal(typeof geminiConfigured(), "boolean");
});
