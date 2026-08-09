/**
 * Phase 6 batch: run dual-independent-extraction across every remaining
 * unresolved pin in the fixtures.
 *
 *   node scripts/run-pin-batch.js              # all remaining parts
 *   node scripts/run-pin-batch.js MIMXRT1172CVM8A FS32K116LFT0MLFT
 *
 * Auto-accepted results are written to data/auto-verified-pinouts.json, which
 * curatedPinouts.js merges. Disagreements and gate failures are collected into
 * one batch report for human review — not drip-fed one part at a time.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../src/config.js";
import { buildValidatedDesign } from "../src/design/validatedDesign.js";
import { resolveComponents } from "../src/design/resolver.js";
import { fetchDatasheet } from "../src/design/datasheetExtraction.js";
import {
  extractWithVerification,
  extractorBKey,
  detectProvider,
  OUTCOME,
} from "../src/design/dualExtraction.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, "../data");
const fixturesDir = path.resolve(here, "../../test-fixtures");
const dsCacheDir = path.join(dataDir, "datasheets");
const AUTO_PATH = path.join(dataDir, "auto-verified-pinouts.json");
const REPORT_PATH = path.join(dataDir, "pin-batch-report.json");

fs.mkdirSync(dsCacheDir, { recursive: true });

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const provider = detectProvider(extractorBKey());
if (!provider) {
  console.error("Extractor B is not configured — refusing to run (auto-accept requires two independent extractors).");
  process.exit(1);
}
console.log(`Extractor A: gemini-flash-latest    Extractor B: ${provider.name} / ${provider.defaultModel}\n`);

// ---------------------------------------------------------------------------
// 1. What still needs resolving, straight from the fixtures
// ---------------------------------------------------------------------------
const partsCache = JSON.parse(fs.readFileSync(path.join(dataDir, "parts-cache.json"), "utf8"));
const pinoutCache = JSON.parse(fs.readFileSync(path.join(dataDir, "pinout-cache.json"), "utf8"));

const targets = new Map();
for (const fixture of fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".json"))) {
  const upstream = JSON.parse(fs.readFileSync(path.join(fixturesDir, fixture), "utf8"));
  const validated = buildValidatedDesign(upstream);
  const nets = validated.design.nets.map((net) => ({
    connections: net.members.map((m) => `${m.ref_id}.${m.logicalPin}`),
  }));
  const resolved = await resolveComponents(upstream.components, nets, { allowNetwork: false });

  for (const component of resolved.components) {
    const unresolved = Object.entries(component.resolution.pins.perPin ?? {})
      .filter(([, detail]) => !detail.real)
      .map(([pin]) => pin);
    if (unresolved.length === 0) continue;

    const existing = targets.get(component.part_number);
    const pins = new Set([...(existing?.pins ?? []), ...unresolved]);
    targets.set(component.part_number, {
      partNumber: component.part_number,
      package: component.package,
      footprint: component.resolution.footprint.value,
      pins: [...pins].sort(),
    });
  }
}

const queue = [...targets.values()]
  .filter((t) => (only.length === 0 ? true : only.includes(t.partNumber)))
  .sort((a, b) => a.partNumber.localeCompare(b.partNumber));

console.log(`${queue.length} part(s) with unresolved pins, ${queue.reduce((n, t) => n + t.pins.length, 0)} pin(s) total\n`);

// ---------------------------------------------------------------------------
// 2. Run each part
// ---------------------------------------------------------------------------
const autoVerified = fs.existsSync(AUTO_PATH) ? JSON.parse(fs.readFileSync(AUTO_PATH, "utf8")) : {};
const report = { generatedAt: new Date().toISOString(), extractorB: provider.name, parts: [] };

const lcscFor = (partNumber, pkg) => partsCache[`${partNumber}::${pkg}`]?.lcsc ?? null;

async function datasheetFor(partNumber, lcsc) {
  const cached = path.join(dsCacheDir, `${lcsc}.txt`);
  if (fs.existsSync(cached)) return { ok: true, text: fs.readFileSync(cached, "utf8"), url: `cached:${lcsc}` };
  const fetched = await fetchDatasheet(partNumber, lcsc);
  if (fetched.ok) fs.writeFileSync(cached, fetched.text);
  return fetched;
}

for (const target of queue) {
  const lcsc = lcscFor(target.partNumber, target.package);
  const entry = {
    partNumber: target.partNumber,
    package: target.package,
    lcsc,
    requestedPins: target.pins,
    autoAccepted: [],
    needsReview: [],
    notFound: [],
  };

  process.stdout.write(`${target.partNumber.padEnd(22)} ${String(lcsc ?? "-").padEnd(11)} pins=${target.pins.join(",").padEnd(28)} `);

  if (!lcsc) {
    entry.notFound = target.pins.map((pin) => ({ logical_pin: pin, reason: "no LCSC code — part not in the catalogue" }));
    report.parts.push(entry);
    console.log("SKIP (no catalogue entry)");
    continue;
  }

  const datasheet = await datasheetFor(target.partNumber, lcsc);
  if (!datasheet.ok) {
    entry.notFound = target.pins.map((pin) => ({ logical_pin: pin, reason: datasheet.reason }));
    report.parts.push(entry);
    console.log("SKIP (no datasheet)");
    continue;
  }
  entry.datasheetUrl = datasheet.url;
  entry.datasheetChars = datasheet.text.length;

  // Pad vocabulary: the identifiers the datasheet itself would use.
  const pinout = pinoutCache[target.footprint];
  const padAliases = pinout?.ok ? pinout.pins : null;
  const padCount = pinout?.padCount ?? 0;
  const footprintPads = Array.from({ length: padCount }, (_, i) => `pin${i + 1}`);
  const ballNames = padAliases ? Object.keys(padAliases) : [];
  // For a BGA the datasheet speaks in ball ids, so offer those; otherwise pins.
  const padVocabulary = ballNames.length > 0 && ballNames.length >= padCount * 0.9 ? ballNames : footprintPads;

  let outcome;
  try {
    outcome = await extractWithVerification({
      partNumber: target.partNumber,
      pkg: target.package,
      neededPins: target.pins,
      datasheetText: datasheet.text,
      footprintPads,
      padAliases,
      padVocabulary,
    });
  } catch (error) {
    entry.notFound = target.pins.map((pin) => ({ logical_pin: pin, reason: `extraction error: ${error.message}` }));
    report.parts.push(entry);
    console.log(`ERROR ${error.message.slice(0, 40)}`);
    continue;
  }

  for (const comparison of outcome.comparisons) {
    if (comparison.outcome === OUTCOME.AUTO_ACCEPTED) {
      entry.autoAccepted.push({
        logical_pin: comparison.logical_pin,
        physical_pin: comparison.physical_pin,
        evidenceA: comparison.a.evidence,
        evidenceB: comparison.b.evidence,
      });
    } else if (comparison.outcome === OUTCOME.NEEDS_REVIEW) {
      entry.needsReview.push({
        logical_pin: comparison.logical_pin,
        reason: comparison.reason,
        a: comparison.a && { pin: comparison.a.physical_pin, evidence: comparison.a.evidence, gates: comparison.a.gates },
        b: comparison.b && { pin: comparison.b.physical_pin, evidence: comparison.b.evidence, gates: comparison.b.gates },
      });
    } else {
      entry.notFound.push({ logical_pin: comparison.logical_pin, reason: comparison.reason });
    }
  }

  if (entry.autoAccepted.length > 0) {
    autoVerified[`${target.partNumber}::${target.package}`] ??= {
      partNumber: target.partNumber,
      package: target.package,
      datasheetUrl: datasheet.url,
      verifiedBy: `dual-extraction: gemini + ${provider.name}`,
      verifiedAt: new Date().toISOString(),
      pins: {},
    };
    for (const accepted of entry.autoAccepted) {
      autoVerified[`${target.partNumber}::${target.package}`].pins[accepted.logical_pin] = {
        pad: accepted.physical_pin,
        evidence: accepted.evidenceB || accepted.evidenceA,
      };
    }
  }

  report.parts.push(entry);
  console.log(
    `auto=${entry.autoAccepted.length} review=${entry.needsReview.length} none=${entry.notFound.length}`
  );
}

fs.writeFileSync(AUTO_PATH, `${JSON.stringify(autoVerified, null, 2)}\n`);
fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

// ---------------------------------------------------------------------------
// 3. Batch summary
// ---------------------------------------------------------------------------
const totals = report.parts.reduce(
  (acc, part) => ({
    auto: acc.auto + part.autoAccepted.length,
    review: acc.review + part.needsReview.length,
    none: acc.none + part.notFound.length,
  }),
  { auto: 0, review: 0, none: 0 }
);

console.log(`\n${"=".repeat(74)}\nBATCH SUMMARY\n${"=".repeat(74)}`);
console.log(`auto-accepted: ${totals.auto}   needs review: ${totals.review}   PIN_NOT_FOUND: ${totals.none}`);

if (totals.auto > 0) {
  console.log(`\nAUTO-ACCEPTED (both extractors agreed independently, both passed both gates):`);
  for (const part of report.parts.filter((p) => p.autoAccepted.length > 0)) {
    for (const accepted of part.autoAccepted) {
      console.log(`  ${part.partNumber.padEnd(22)} ${accepted.logical_pin.padEnd(7)} -> ${accepted.physical_pin}`);
    }
  }
}

if (totals.review > 0) {
  console.log(`\nNEEDS REVIEW:`);
  for (const part of report.parts.filter((p) => p.needsReview.length > 0)) {
    for (const item of part.needsReview) {
      console.log(`  ${part.partNumber} ${item.logical_pin}: ${item.reason.slice(0, 120)}`);
    }
  }
}

console.log(`\nreport: ${REPORT_PATH}`);
console.log(`auto-verified pinouts: ${AUTO_PATH}`);
