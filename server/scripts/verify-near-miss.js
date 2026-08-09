/**
 * REQUIRED VALIDATION (PROJECT_PLAN Phase 6): reconstruct the LP103SB6F
 * near-miss as a controlled test.
 *
 * The failure mode being tested is real and already observed: LP103SB6F's
 * datasheet contains BOTH
 *   - a per-package table  -> GND = pin2   (correct, authoritative)
 *   - a package diagram    -> reads as pin5 (wrong)
 * Both are genuinely verbatim in the PDF, so BOTH pass both deterministic gates.
 * Only disagreement between independent readings can catch this.
 *
 * Construction: one extraction path is given ONLY the diagram section (the
 * table is withheld), so it should land on the wrong pin. The other reads the
 * full datasheet. The comparator must flag DISAGREEMENT rather than
 * auto-accepting either answer.
 *
 * Run: node scripts/near-miss-test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../src/config.js";
import { fetchDatasheet, callGemini } from "../src/design/datasheetExtraction.js";
import { extractWithVerification, callGrok, OUTCOME } from "../src/design/dualExtraction.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.resolve(here, "../data/near-miss-datasheet.txt");

const PADS = ["pin1", "pin2", "pin3", "pin4", "pin5", "pin6"];
const TABLE_MARKER = "Functional Pin Description";

// ---------------------------------------------------------------------------
// 1. Real datasheet
// ---------------------------------------------------------------------------
let datasheetText;
if (fs.existsSync(CACHE)) {
  datasheetText = fs.readFileSync(CACHE, "utf8");
  console.log(`datasheet: ${datasheetText.length} chars (cached)`);
} else {
  const fetched = await fetchDatasheet("LP103SB6F", "C387729");
  if (!fetched.ok) {
    console.error(`FAILED to fetch datasheet: ${fetched.reason}`);
    process.exit(1);
  }
  datasheetText = fetched.text;
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, datasheetText);
  console.log(`datasheet: ${datasheetText.length} chars from ${fetched.url.slice(0, 70)}`);
}

const tableAt = datasheetText.indexOf(TABLE_MARKER);
if (tableAt < 0) {
  console.error("FAILED: could not locate the pin-description table to withhold.");
  process.exit(1);
}
const diagramOnly = datasheetText.slice(0, tableAt);

console.log(
  `\nrestricted view: ${diagramOnly.length} chars — package diagram present, ` +
    `authoritative table withheld (${/GND\s+3\s+2\s+Ground/.test(diagramOnly) ? "TABLE LEAKED — BAD" : "table absent, correct"})`
);

// ---------------------------------------------------------------------------
// 2. Two independent extractions, different views of the same source
// ---------------------------------------------------------------------------
// Extractor B is Grok when credits allow. When it is unavailable this falls
// back to a second Gemini call on the FULL text — which still exercises the
// comparator, but does NOT demonstrate cross-model independence. The banner
// below says which mode actually ran, so the result is never overstated.
const grokProbe = await callGrok("Reply with the single word OK");
const grokAvailable = grokProbe.ok;

const extractors = [
  {
    id: "A",
    name: "gemini(diagram-only)",
    model: "gemini-flash-latest",
    call: callGemini,
    datasheetText: diagramOnly, // restricted on purpose
  },
  grokAvailable
    ? { id: "B", name: "grok(full)", model: "grok-3", call: callGrok }
    : { id: "B", name: "gemini(full)", model: "gemini-flash-latest", call: callGemini },
];

console.log(
  grokAvailable
    ? "\nmode: CROSS-MODEL (Gemini restricted vs Grok full) — full design under test"
    : `\nmode: SINGLE-MODEL (Gemini restricted vs Gemini full) — Grok unavailable: ${grokProbe.reason}\n` +
        "      This tests the COMPARATOR only. Cross-model independence is NOT demonstrated."
);

const result = await extractWithVerification({
  partNumber: "LP103SB6F",
  pkg: "SOT-23-6",
  neededPins: ["GND"],
  datasheetText,
  footprintPads: PADS,
  extractors,
});

// ---------------------------------------------------------------------------
// 3. Report + assert
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(72));
for (const comparison of result.comparisons) {
  console.log(`pin ${comparison.logical_pin}: ${comparison.outcome.toUpperCase()}`);
  console.log(`  ${comparison.reason}`);
  for (const [label, claim] of [["A (restricted)", comparison.a], ["B (full)", comparison.b]]) {
    if (!claim) {
      console.log(`  ${label}: no claim returned`);
      continue;
    }
    console.log(
      `  ${label}: ${claim.physical_pin}  gates[structural=${claim.gates.structural.pass} ` +
        `evidence=${claim.gates.evidence.pass}/${claim.gates.evidence.score}]`
    );
    console.log(`      evidence: "${String(claim.evidence).slice(0, 110)}"`);
  }
}
console.log("=".repeat(72));

const gnd = result.comparisons.find((c) => c.logical_pin === "GND");
const a = gnd?.a;
const b = gnd?.b;

const checks = [
  ["restricted extractor produced a claim", Boolean(a)],
  ["full-view extractor produced a claim", Boolean(b)],
  ["the two extractions landed on DIFFERENT pins", a && b && a.physical_pin !== b.physical_pin],
  ["comparator did NOT auto-accept", gnd?.outcome !== OUTCOME.AUTO_ACCEPTED],
  ["comparator routed to human review", gnd?.outcome === OUTCOME.NEEDS_REVIEW],
  ["full-view extractor found the correct pin2", b?.physical_pin === "pin2"],
];

console.log();
let allPassed = true;
for (const [label, passed] of checks) {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) allPassed = false;
}

// The sharpest point: if both passed both gates and still disagreed, the
// deterministic gates alone were provably insufficient here.
if (a?.passed && b?.passed && a.physical_pin !== b.physical_pin) {
  console.log(
    "\nNOTE: both readings passed BOTH deterministic gates and still disagreed —\n" +
      "      this is the case gates alone cannot catch, and the reason independent\n" +
      "      re-extraction exists."
  );
}

console.log(`\n${allPassed ? "NEAR-MISS RECONSTRUCTION: PASSED" : "NEAR-MISS RECONSTRUCTION: FAILED"}`);
if (!grokAvailable) {
  console.log("SCOPE: comparator proven; cross-model independence NOT proven (Grok has no credits).");
}
process.exit(allPassed ? 0 : 1);
