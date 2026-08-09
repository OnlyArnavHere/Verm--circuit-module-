/**
 * Phase 8 end-to-end: a natural-language repositioning request against a real
 * fixture, producing a genuine v2 — or an explicit rejection that leaves v1
 * untouched.
 *
 *   node scripts/run-modification.js smart_dustbin "move the BLE module closer to the left edge"
 *   node scripts/run-modification.js smart_dustbin --instruction '{"type":...}'   # skip the LLM
 *
 * Everything after the interpretation step is the existing pipeline, unchanged.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../src/config.js";
import { buildValidatedDesign } from "../src/design/validatedDesign.js";
import { resolveComponents } from "../src/design/resolver.js";
import { compileDesign } from "../src/compile/compile.js";
import { interpretRequest } from "../src/design/interpretRequest.js";
import { applyModification, INSTRUCTION_TYPE } from "../src/design/modification.js";
import { installHttpCache } from "../src/services/httpCache.js";
import { componentSizesFrom } from "../src/design/placement.js";
import { verifyTarget, TARGET_VERDICT } from "../src/design/targetCheck.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../test-fixtures");
const outRoot = path.resolve(here, "../../artifacts");

const args = process.argv.slice(2);
const fixture = args[0];
const explicitIndex = args.indexOf("--instruction");
const explicitInstruction = explicitIndex !== -1 ? JSON.parse(args[explicitIndex + 1]) : null;
const request = explicitInstruction
  ? args.slice(1, explicitIndex).join(" ") || "(explicit instruction supplied)"
  : args.slice(1).join(" ");

if (!fixture || !request) {
  console.error('Usage: node scripts/run-modification.js <fixture> "<request>"');
  process.exit(1);
}

installHttpCache({ mode: "readwrite" });

const upstream = JSON.parse(fs.readFileSync(path.join(fixturesDir, `${fixture}.json`), "utf8"));

/** Compile a ValidatedDesign into a version directory. Existing pipeline, unchanged. */
async function buildVersion(design, versionDir) {
  const nets = design.nets.map((net) => ({
    name: net.name,
    net_class: net.net_class,
    connections: net.members.map((m) => `${m.ref_id}.${m.logicalPin}`),
  }));
  const resolution = await resolveComponents(upstream.components, nets);
  fs.rmSync(versionDir, { recursive: true, force: true });

  const compiled = await compileDesign({
    upstream: { ...upstream, nets, placement: design.placement },
    resolvedComponents: resolution.components,
    outDir: versionDir,
  });
  return { compiled, resolution };
}

// Real footprint extents from the compiled v1 board — not an estimate.

// ---------------------------------------------------------------------------
// v1 — the baseline
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(74)}\nv1 — baseline\n${"=".repeat(74)}`);
const v1Design = buildValidatedDesign(upstream).design;
const v1Dir = path.join(outRoot, `${fixture}-v1`);
const v1 = await buildVersion(v1Design, v1Dir);

const v1Hashes = Object.fromEntries(
  ["circuit", "schematic", "pcb", "model3d"].map((k) => [k, v1.compiled.artifacts[k]?.sha256])
);
console.log(`DRC: ${v1.compiled.drc.errors.length} failures, ${v1.compiled.drc.warnings.length} warnings`);
console.log(`placement U3: ${JSON.stringify(v1Design.placement.components.U3)}`);

// ---------------------------------------------------------------------------
// Interpret
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(74)}\nrequest: "${request}"\n${"=".repeat(74)}`);

let instruction = explicitInstruction;
let interpretedBy = "explicit";
if (!instruction) {
  const interpreted = await interpretRequest({ request, design: v1Design });
  if (!interpreted.ok) {
    console.log(`REJECTED at interpretation: ${interpreted.errors[0].message}`);
    process.exit(2);
  }
  instruction = interpreted.instruction;
  interpretedBy = interpreted.interpretedBy;
}

console.log(`interpreted by: ${interpretedBy}`);
console.log(JSON.stringify(instruction, null, 2));

if (instruction.type === INSTRUCTION_TYPE.UNSUPPORTED) {
  console.log(`\nUNSUPPORTED (${instruction.requested_change_class}): ${instruction.reason}`);
  console.log("v1 untouched, no version created.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Semantic target check
//
// DRC validates geometry; it cannot tell that the WRONG component was moved to
// a perfectly legal place. This compares the user's own words against the
// resolved part's real class — printed up front, because a warning nobody sees
// is not a warning.
// ---------------------------------------------------------------------------
const targetCheck = verifyTarget(request, instruction.target.ref_id, upstream.components);

if (targetCheck.verdict === TARGET_VERDICT.MISMATCH) {
  console.log(`\n${"*".repeat(74)}`);
  console.log(`TARGET MISMATCH — the moved component may not be the one you meant`);
  console.log(`  ${targetCheck.message}`);
  if (targetCheck.candidates?.length) console.log(`  candidates: ${targetCheck.candidates.join("; ")}`);
  console.log(`  Proceeding — geometry is still fully validated — but review this.`);
  console.log(`${"*".repeat(74)}`);
} else if (targetCheck.verdict === TARGET_VERDICT.AMBIGUOUS) {
  console.log(`\n>> TARGET AMBIGUOUS: ${targetCheck.message}`);
} else {
  console.log(`\ntarget check: ${targetCheck.verdict} — ${targetCheck.message}`);
}

// ---------------------------------------------------------------------------
// Deterministic apply
// ---------------------------------------------------------------------------
const sizes = componentSizesFrom(v1.compiled.circuitJson);
console.log(`\nreal footprint sizes: ${Object.entries(sizes).map(([r,s])=>`${r}=${s.width_mm?.toFixed(1)}x${s.height_mm?.toFixed(1)}`).join(" ")}`);
const applied = applyModification(instruction, v1Design, sizes);

if (!applied.ok) {
  console.log(`\nREJECTED at deterministic validation:`);
  for (const error of applied.errors) console.log(`  ${error.code}: ${error.message}`);
  console.log("\nNo version created. v1 untouched.");
  process.exit(3);
}

console.log(
  `\nresolved placement: ${instruction.target.ref_id} ` +
    `(${applied.resolved.from.x_mm}, ${applied.resolved.from.y_mm}) -> ` +
    `(${applied.resolved.to.x_mm}, ${applied.resolved.to.y_mm})`
);

// ---------------------------------------------------------------------------
// v2 — recompile, then DRC gate
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(74)}\nv2 — recompiling\n${"=".repeat(74)}`);
const v2Dir = path.join(outRoot, `${fixture}-v2`);
const v2 = await buildVersion(applied.design, v2Dir);

const newFailures = v2.compiled.drc.errors.length;
const warningDelta = v2.compiled.drc.warnings.length - v1.compiled.drc.warnings.length;

console.log(
  `DRC: ${newFailures} failures, ${v2.compiled.drc.warnings.length} warnings ` +
    `(delta ${warningDelta >= 0 ? "+" : ""}${warningDelta}, non-blocking)`
);
console.log(
  `assertions: padIntegrity=${v2.compiled.assertions.padIntegrity.ok ? "PASS" : "FAIL"} ` +
    `netsRealized=${v2.compiled.assertions.netsRealized.ok ? "PASS" : "FAIL"}`
);

// THE GATE: new DRC failures block the version. Warnings never do.
if (newFailures > 0) {
  console.log(`\n${"!".repeat(74)}`);
  console.log(`v2 BLOCKED — the repositioning introduced ${newFailures} DRC failure(s):`);
  for (const error of v2.compiled.drc.errors.slice(0, 5)) {
    console.log(`  ${error.code}: ${error.message.slice(0, 110)}`);
  }
  console.log(`\nNo version committed. v1 remains current and unchanged.`);
  console.log(`${"!".repeat(74)}`);

  // Verify v1 really is untouched.
  const v1Now = Object.fromEntries(
    ["circuit", "schematic", "pcb", "model3d"].map((k) => {
      const file = path.join(v1Dir, v1.compiled.artifacts[k].filename);
      const buf = fs.readFileSync(file);
      return [k, crypto.createHash("sha256").update(buf).digest("hex")];
    })
  );
  const unchanged = Object.entries(v1Hashes).every(([k, h]) => v1Now[k] === h);
  console.log(`v1 artifacts unchanged: ${unchanged ? "CONFIRMED" : "CHANGED — BUG"}`);
  process.exit(4);
}

// ---------------------------------------------------------------------------
// Committed
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(74)}\nv2 COMMITTED\n${"=".repeat(74)}`);
for (const kind of ["circuit", "schematic", "pcb", "model3d"]) {
  const a1 = v1.compiled.artifacts[kind];
  const a2 = v2.compiled.artifacts[kind];
  console.log(
    `  ${kind.padEnd(10)} v1 ${String(a1?.sha256).slice(0, 12)} -> v2 ${String(a2?.sha256).slice(0, 12)}` +
      `  ${a1?.sha256 === a2?.sha256 ? "(identical)" : "(regenerated)"}`
  );
}

const v1After = Object.fromEntries(
  ["circuit", "schematic", "pcb", "model3d"].map((k) => {
    const buf = fs.readFileSync(path.join(v1Dir, v1.compiled.artifacts[k].filename));
    return [k, crypto.createHash("sha256").update(buf).digest("hex")];
  })
);
const v1Intact = Object.entries(v1Hashes).every(([k, h]) => v1After[k] === h);
// Repeated at the end so it survives a long compile log — the requirement is
// visibility, and a warning 200 lines up has effectively been buried.
if (targetCheck.verdict === TARGET_VERDICT.MISMATCH) {
  console.log(`\n${"*".repeat(74)}`);
  console.log(`REMINDER — TARGET MISMATCH on this version: ${targetCheck.message}`);
  console.log(`${"*".repeat(74)}`);
}

console.log(`\nv1 artifacts still on disk and unchanged: ${v1Intact ? "CONFIRMED" : "CHANGED — BUG"}`);
console.log(`v1 dir: ${v1Dir}`);
console.log(`v2 dir: ${v2Dir}`);
process.exit(v1Intact ? 0 : 5);
