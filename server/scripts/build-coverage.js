#!/usr/bin/env node
/**
 * Build the pin-coverage table from upstream shortlists.
 *
 * WHY THIS EXISTS
 * ---------------
 * Upstream ranks candidate parts without any knowledge of their pins: its
 * `interface_match` dimension can only read catalogue attributes, which carry a
 * populated `Interface` field for roughly 8% of parts. This table gives it
 * verified per-part pin data so that dimension can become a real signal instead
 * of a near-constant.
 *
 * WHY extractPinout AND NOT resolveComponents
 * -------------------------------------------
 * `resolveComponents()` answers "do the pins THIS DESIGN asked for resolve?" —
 * it needs nets, and reports only the requested roles. A coverage table needs
 * the opposite: the part's COMPLETE named pin set, independent of any design.
 * That is exactly `extractPinout()`'s output, and it is the same underlying
 * resolution minus a lookup we do not need — the shortlist already carries the
 * LCSC id, so the MPN -> LCSC parts-engine step is redundant here.
 *
 * COST
 * ----
 * ~5.1 s/part cold, ~1 ms once cached, measured. One-time per part: results
 * persist in `data/pinout-cache.json`, so re-runs only pay for new parts.
 *
 * USAGE
 *   node scripts/build-coverage.js                     # from the shortlist log
 *   node scripts/build-coverage.js --limit 25          # cap this run
 *   node scripts/build-coverage.js --input path.jsonl  # explicit shortlist
 *   node scripts/build-coverage.js --offline           # cache only, no network
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractPinout, matchLogicalPin } from "../src/design/pinout.js";
import { resolveRole, candidatesFor } from "../src/design/roleMap.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(here, "../../data/coverage/pin-coverage.json");
const DEFAULT_INPUT = path.resolve(
  here,
  "../../../dunkai/ai_engine/data/shortlist-log.jsonl"
);

/** Schema version of the emitted table. Bump when the shape changes. */
const COVERAGE_SCHEMA = 1;

/**
 * Roles that must ALL resolve for an interface to count as confirmed.
 * Chip select is excluded for SPI: plenty of real SPI parts expose SCK/MOSI/MISO
 * and take their select line from a GPIO, so requiring it would under-report.
 */
const REQUIRED_ROLES = Object.freeze({
  I2C: ["CLOCK", "DATA"],
  SPI: ["CLOCK", "MOSI", "MISO"],
  UART: ["TX", "RX"],
  CAN: ["CAN_H", "CAN_L"],
  USB: ["DP", "DM"],
  I2S: ["BIT_CLOCK", "WORD_CLOCK", "DATA"],
  Power: ["SUPPLY", "GROUND"],
});

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? true) : fallback;
};
const has = (name) => args.includes(name);

const inputPath = flag("--input", DEFAULT_INPUT);
const limit = Number(flag("--limit", 0)) || 0;
const allowNetwork = !has("--offline");

/** Read the append-only shortlist log, de-duplicated by LCSC id. */
function readShortlist(file) {
  if (!fs.existsSync(file)) {
    console.error(`No shortlist at ${file}.`);
    console.error("Upstream writes it on each design run (component_node).");
    process.exit(1);
  }
  const byLcsc = new Map();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a torn last line must not abort the batch
    }
    if (!row.lcsc) continue;
    if (!byLcsc.has(row.lcsc)) byLcsc.set(row.lcsc, row);
  }
  return [...byLcsc.values()];
}

/**
 * Which interfaces this part demonstrably supports, from its REAL pin names.
 * Silence is not evidence: an interface simply absent from this list means
 * "not confirmed", never "not supported" — see the consumer contract below.
 */
function confirmedInterfaces(pinout) {
  const confirmed = [];
  for (const [iface, roles] of Object.entries(REQUIRED_ROLES)) {
    const all = roles.every((role) => {
      if (!candidatesFor(iface, role)) return false;
      return resolveRole(iface, role, pinout, matchLogicalPin).ok;
    });
    if (all) confirmed.push(iface);
  }
  return confirmed;
}

function loadExisting() {
  try {
    return JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const shortlist = readShortlist(inputPath);
  const existing = loadExisting();
  const parts = existing?.parts ? { ...existing.parts } : {};

  const todo = shortlist.filter((row) => !parts[row.lcsc]);
  const batch = limit ? todo.slice(0, limit) : todo;

  console.log(`shortlist: ${shortlist.length} distinct parts`);
  console.log(`already covered: ${shortlist.length - todo.length}`);
  console.log(`resolving now: ${batch.length}${limit ? ` (--limit ${limit})` : ""}`);
  console.log(`network: ${allowNetwork ? "on" : "OFF (cache only)"}\n`);

  const started = Date.now();
  let ok = 0;
  let unnamed = 0;
  let failed = 0;

  for (const [index, row] of batch.entries()) {
    const footprint = `jlcpcb:${row.lcsc}`;
    const t0 = Date.now();
    let pinout;
    try {
      pinout = await extractPinout(footprint, { allowNetwork });
    } catch (error) {
      // A transport failure is NOT a domain answer: record nothing rather than
      // writing a zero-coverage entry that would read as "this part has no pins".
      console.log(`  [${index + 1}/${batch.length}] ${row.lcsc} FETCH FAILED — skipped (${error.message})`);
      failed += 1;
      continue;
    }
    const ms = Date.now() - t0;

    const pins = pinout.pins ?? {};
    const names = Object.keys(pins);
    const padCount = pinout.padCount ?? 0;
    // COUNT PADS, NOT NAMES. `pins` maps NAME -> pad, and a pad can carry
    // several aliases via port_hints, so a part can expose more names than it
    // has pads (observed: C22392413, 30 pads / 57 names). Counting names would
    // overstate coverage and could mark a partially-named part "complete",
    // which is precisely the condition that licenses a negative claim.
    const namedPads = new Set(Object.values(pins)).size;

    if (!pinout.ok || padCount === 0) {
      // Distinguish "resolved, exposes nothing" from "never resolved": the
      // former is a real, recordable fact about the catalogue entry.
      parts[row.lcsc] = {
        mfr_part: row.mfr_part ?? null,
        package: row.package ?? null,
        footprint,
        pad_count: padCount,
        named_count: 0,
        named_pads: 0,
        naming_complete: false,
        names: [],
        interfaces_confirmed: [],
        note: pinout.message ?? "footprint resolved but exposes no named pins",
        resolved_at: new Date().toISOString(),
      };
      unnamed += 1;
      console.log(`  [${index + 1}/${batch.length}] ${row.lcsc} ${String(ms).padStart(6)}ms  pads=${padCount} named=0  (no named pins)`);
      continue;
    }

    const interfaces = confirmedInterfaces(pinout);
    parts[row.lcsc] = {
      mfr_part: row.mfr_part ?? null,
      package: row.package ?? null,
      footprint,
      pad_count: padCount,
      named_count: names.length,
      named_pads: namedPads,
      // The guard that makes a NEGATIVE claim sound. Only when every PAD is
      // named can "this interface is absent" be trusted (same rule as
      // capabilityCheck.js). Consumers must not infer absence without it.
      naming_complete: namedPads === padCount,
      names: names.sort(),
      interfaces_confirmed: interfaces,
      resolved_at: new Date().toISOString(),
    };
    ok += 1;
    console.log(
      `  [${index + 1}/${batch.length}] ${row.lcsc} ${String(ms).padStart(6)}ms  ` +
        `pads=${padCount} named=${namedPads}/${padCount}${namedPads === padCount ? " COMPLETE" : ""}` +
        `${interfaces.length ? `  -> ${interfaces.join(",")}` : ""}`
    );
  }

  const table = {
    schema: COVERAGE_SCHEMA,
    generated_at: new Date().toISOString(),
    part_count: Object.keys(parts).length,
    // Read this before trusting a lookup:
    contract: {
      absent_from_table: "NOT resolved. Unknown coverage — never interpret as 'no interfaces'.",
      naming_complete_false:
        "Partial pin naming. An interface missing from interfaces_confirmed is UNKNOWN, not absent.",
      naming_complete_true:
        "Every pad is named. Only here may a missing interface be read as genuinely absent.",
    },
    parts: Object.fromEntries(Object.entries(parts).sort(([a], [b]) => a.localeCompare(b))),
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(table, null, 2)}\n`);

  const complete = Object.values(parts).filter((p) => p.naming_complete).length;
  const withIface = Object.values(parts).filter((p) => p.interfaces_confirmed.length).length;
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n  resolved ${ok} | no-named-pins ${unnamed} | fetch-failed ${failed} | ${elapsed}s`);
  console.log(`  table now holds ${table.part_count} parts`);
  console.log(`    naming complete (negatives trustworthy): ${complete}`);
  console.log(`    with >=1 confirmed interface:            ${withIface}`);
  console.log(`\n  wrote ${OUT_PATH}`);
}

await main();
