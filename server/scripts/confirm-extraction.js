/**
 * The human-confirm gate for datasheet extractions.
 *
 * Passing both deterministic gates only makes a claim *eligible*. Nothing
 * becomes trusted until a person checks it against the real datasheet and runs
 * this. Kept as an explicit command so confirmation is a deliberate, recorded
 * act rather than someone editing a JSON file.
 *
 *   node scripts/confirm-extraction.js --list
 *   node scripts/confirm-extraction.js --part LP103SB6F --package SOT-23-6 --show
 *   node scripts/confirm-extraction.js --part LP103SB6F --package SOT-23-6 \
 *        --confirm GND --by "vrusha"
 */
import fs from "node:fs";
import { EXTRACTION_CACHE_PATH, EXTRACTION_STATUS } from "../src/design/datasheetExtraction.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1] ?? true;
};

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(EXTRACTION_CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
};
const save = (cache) =>
  fs.writeFileSync(EXTRACTION_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);

const cache = load();

if (args.includes("--list") || args.length === 0) {
  const entries = Object.entries(cache);
  if (entries.length === 0) {
    console.log("No extractions cached yet.");
    process.exit(0);
  }
  for (const [key, record] of entries) {
    const counts = {};
    for (const result of record.results ?? []) {
      counts[result.status] = (counts[result.status] ?? 0) + 1;
    }
    console.log(
      `${key.padEnd(30)} ${JSON.stringify(counts)}  confirmedBy=${record.confirmedBy ?? "-"}`
    );
  }
  process.exit(0);
}

const part = flag("part");
const pkg = flag("package");
const key = `${part}::${pkg}`;
const record = cache[key];

if (!record) {
  console.error(`No extraction cached for "${key}". Run --list to see what exists.`);
  process.exit(1);
}

if (flag("show")) {
  console.log(`part:      ${record.partNumber} (${record.package}, ${record.lcsc})`);
  console.log(`datasheet: ${record.datasheetUrl}`);
  console.log(`extracted: ${record.extractedAt}`);
  console.log(`confirmed: ${record.confirmedBy ?? "NOT CONFIRMED"}`);
  console.log(`requested pins: ${record.neededPins.join(", ")}\n`);

  for (const result of record.results) {
    console.log(`  ${result.logical_pin} -> ${result.physical_pin}   [${result.status}]`);
    console.log(`     gate1 structural: ${result.gates.structural.pass} — ${result.gates.structural.reason}`);
    console.log(
      `     gate2 evidence:   ${result.gates.evidence.pass} (score ${result.gates.evidence.score})`
    );
    console.log(`     evidence: "${result.evidence}"`);
    console.log(`     model-reported confidence (NOT a gate): ${result.reportedConfidence}`);
  }

  const missing = record.neededPins.filter(
    (pin) => !record.results.some((r) => r.logical_pin === pin)
  );
  if (missing.length > 0) {
    console.log(`\n  not returned by the model: ${missing.join(", ")}`);
    console.log(`  -> these remain PIN_NOT_FOUND, which is the correct outcome if the`);
    console.log(`     part genuinely has no such pin.`);
  }
  process.exit(0);
}

const confirmPin = flag("confirm");
const by = flag("by");

if (confirmPin) {
  if (!by || by === true) {
    console.error("--by <name> is required: confirmation must be attributable.");
    process.exit(1);
  }

  const result = record.results.find((r) => r.logical_pin === confirmPin);
  if (!result) {
    console.error(`No extracted claim for pin "${confirmPin}".`);
    process.exit(1);
  }
  // A rejected claim can never be confirmed — the gates are not advisory.
  if (result.status === EXTRACTION_STATUS.REJECTED) {
    console.error(
      `"${confirmPin}" was REJECTED by a deterministic gate and cannot be confirmed.\n` +
        `  structural: ${result.gates.structural.reason}\n` +
        `  evidence:   ${result.gates.evidence.reason}`
    );
    process.exit(1);
  }

  result.status = EXTRACTION_STATUS.VERIFIED;
  record.confirmedBy = by;
  record.confirmedAt = new Date().toISOString();
  save(cache);

  console.log(`Confirmed ${confirmPin} -> ${result.physical_pin} for ${record.partNumber} by ${by}.`);
  console.log(`It is now eligible to be added to curatedPinouts.js.`);
  process.exit(0);
}

console.error("Nothing to do. Use --list, --show, or --confirm <PIN> --by <name>.");
process.exit(1);
