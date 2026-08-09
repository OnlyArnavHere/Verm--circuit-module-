/**
 * Verify that pin-relevant-section reduction (selectPinSections) does not
 * destroy the disagreement-detection design.
 *
 * The concern is concrete: the near-miss depends on LP103SB6F's datasheet
 * containing BOTH readings —
 *   - the per-package TABLE  -> "GND   3   2   Ground."      (correct, pin2)
 *   - the package DIAGRAM    -> "1 2 3 4 5 6 D+ D- PS ..."   (reads as pin5)
 * If excerpting dropped either, the two extractors could no longer disagree and
 * the design would silently lose the property it was validated on.
 *
 * This checks the text each extractor ACTUALLY receives, and — because
 * LP103SB6F is small enough that reduction is a no-op — also forces reduction
 * with a small cap to prove the selector keeps both sections when it does fire.
 *
 * Run: node scripts/verify-excerpting.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectPinSections } from "../src/design/datasheetExtraction.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const full = fs.readFileSync(path.resolve(here, "../data/near-miss-datasheet.txt"), "utf8");

const TABLE = /GND\s+3\s+2\s+Ground/; // the authoritative per-package row -> pin2
const DIAGRAM = /D\+\s+D-\s+PS\s+QC_EN\s+GND\s+FBO/; // the diagram -> reads as pin5
const tableAt = full.indexOf("Functional Pin Description");
const diagramOnly = full.slice(0, tableAt);

const checks = [];
const check = (label, condition) => {
  checks.push([label, Boolean(condition)]);
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
};

console.log(`source datasheet: ${full.length} chars\n`);

// ---------------------------------------------------------------------------
// 1. What each extractor actually receives in the near-miss run
// ---------------------------------------------------------------------------
console.log("--- text each extractor actually receives (near-miss run) ---");

// Extractor A is given the restricted slice verbatim (no reduction applied to
// an extractor that supplies its own text).
console.log(`A (restricted): ${diagramOnly.length} chars`);
check("A receives the DIAGRAM", DIAGRAM.test(diagramOnly));
check("A does NOT receive the table (the whole point of the restriction)", !TABLE.test(diagramOnly));

// Extractor B is given selectPinSections(full).
const bText = selectPinSections(full, ["GND"]);
console.log(`B (full, after reduction): ${bText.length} chars`);
check("B receives the TABLE", TABLE.test(bText));
check("B receives the DIAGRAM too", DIAGRAM.test(bText));

const reductionFired = bText.length < full.length;
console.log(
  `\nnote: reduction ${reductionFired ? "FIRED" : "was a NO-OP"} for this datasheet ` +
    `(${full.length} chars vs 24000 cap) — so the checks above alone do not ` +
    `exercise the selector. Forcing it below.`
);

// ---------------------------------------------------------------------------
// 2. Force reduction, so the selector is genuinely exercised
// ---------------------------------------------------------------------------
console.log("\n--- forced reduction (small caps) ---");
for (const maxChars of [8000, 5000, 3000]) {
  const reduced = selectPinSections(full, ["GND"], { maxChars });
  const keptTable = TABLE.test(reduced);
  const keptDiagram = DIAGRAM.test(reduced);
  console.log(
    `cap=${String(maxChars).padStart(5)} -> ${String(reduced.length).padStart(5)} chars  ` +
      `table=${keptTable ? "kept" : "LOST"}  diagram=${keptDiagram ? "kept" : "LOST"}`
  );
  check(`cap=${maxChars}: reduction actually fired`, reduced.length < full.length);
  check(`cap=${maxChars}: TABLE survives`, keptTable);
  check(`cap=${maxChars}: DIAGRAM survives`, keptDiagram);
}

// ---------------------------------------------------------------------------
// 3. Both readings must remain simultaneously present — that is what makes
//    disagreement possible at all.
// ---------------------------------------------------------------------------
console.log("\n--- both readings simultaneously present ---");
const tight = selectPinSections(full, ["GND"], { maxChars: 5000 });
check(
  "a single reduced text still contains BOTH the correct and the misleading reading",
  TABLE.test(tight) && DIAGRAM.test(tight)
);

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
console.log(
  failed.length === 0
    ? "EXCERPTING VERIFICATION: PASSED — reduction preserves both readings, so\n" +
        "disagreement detection is intact."
    : "EXCERPTING VERIFICATION: FAILED"
);
process.exit(failed.length === 0 ? 0 : 1);
