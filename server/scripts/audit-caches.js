/**
 * Phase 6.5 — catalogue/cache-completeness audit.
 *
 * For every deterministic lookup the pipeline depends on, check whether it is
 * actually complete for the 19 real fixture parts. Pure deterministic work: no
 * LLM calls.
 *
 * The target is specifically **our data being incomplete** — the D-054 shape,
 * where a correct claim was rejected because a downstream table had no entry.
 * It is NOT "we are appropriately unsure": D-010's exact-package-match rule
 * rejecting a different geometry (e.g. `QFN-16-EP(4x4)` vs plain `qfn16`) is
 * deliberate conservatism and is left alone.
 *
 * Written to be re-runnable, so it stays useful after today.
 *
 *   node scripts/audit-caches.js            # data-level audit (fast, offline)
 *   node scripts/audit-caches.js --probe3d  # also compile-probe 3D models
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../src/config.js";
import { buildValidatedDesign } from "../src/design/validatedDesign.js";
import { resolveComponents } from "../src/design/resolver.js";
import { resolveFootprint } from "../src/design/footprintMap.js";
import { curatedPinout } from "../src/design/curatedPinouts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, "../data");
const fixturesDir = path.resolve(here, "../../test-fixtures");
const probe3d = process.argv.includes("--probe3d");

const partsCache = JSON.parse(fs.readFileSync(path.join(dataDir, "parts-cache.json"), "utf8"));
const pinoutCache = JSON.parse(fs.readFileSync(path.join(dataDir, "pinout-cache.json"), "utf8"));

// ---------------------------------------------------------------------------
// Gather every distinct fixture part and what the pipeline currently makes of it
// ---------------------------------------------------------------------------
const parts = new Map();
for (const file of fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".json"))) {
  const upstream = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), "utf8"));
  const validated = buildValidatedDesign(upstream);
  const nets = validated.design.nets.map((net) => ({
    connections: net.members.map((m) => `${m.ref_id}.${m.logicalPin}`),
  }));
  const resolved = await resolveComponents(upstream.components, nets, { allowNetwork: false });

  for (const component of resolved.components) {
    const key = `${component.part_number}::${component.package}`;
    const existing = parts.get(key) ?? {
      partNumber: component.part_number,
      package: component.package,
      fixtures: new Set(),
      pins: new Map(),
    };
    existing.fixtures.add(file.replace(/\.json$/, ""));
    existing.resolution = component.resolution;
    for (const [pin, detail] of Object.entries(component.resolution.pins.perPin ?? {})) {
      const previous = existing.pins.get(pin);
      if (!previous || (!previous.real && detail.real)) existing.pins.set(pin, detail);
    }
    parts.set(key, existing);
  }
}

const rows = [...parts.values()].sort((a, b) => a.partNumber.localeCompare(b.partNumber));
const findings = [];

// ---------------------------------------------------------------------------
// 1. Parts engine (parts-cache.json) — is every part matched to an LCSC code?
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(80)}\n1. PARTS ENGINE (parts-cache.json)\n${"=".repeat(80)}`);
for (const row of rows) {
  const entry = partsCache[`${row.partNumber}::${row.package}`];
  const status = entry?.ok ? `OK   ${entry.lcsc}` : "MISS";
  console.log(`  ${status.padEnd(14)} ${row.partNumber.padEnd(22)} ${row.package}`);
  if (!entry?.ok) {
    findings.push({
      area: "parts_engine",
      part: row.partNumber,
      detail: entry?.message ?? "no cache entry",
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Footprint mapper — resolved, and by which path?
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(80)}\n2. FOOTPRINT RESOLUTION\n${"=".repeat(80)}`);
for (const row of rows) {
  const footprint = row.resolution.footprint;
  const curated = resolveFootprint(row.package);
  const via = footprint.source;
  console.log(
    `  ${(footprint.value ?? "UNRESOLVED").padEnd(22)} ${via.padEnd(13)} ${row.partNumber.padEnd(22)} ${row.package}`
  );
  if (!footprint.value) {
    findings.push({
      area: "footprint",
      part: row.partNumber,
      detail: `unresolved; curated table says: ${curated.ok ? "hit" : curated.message.slice(0, 80)}`,
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Pinout cache — present, and how completely named?
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(80)}\n3. PINOUT CACHE (pinout-cache.json)\n${"=".repeat(80)}`);
console.log("  named/pads   footprint             part");
for (const row of rows) {
  const footprint = row.resolution.footprint.value;
  if (!footprint) {
    console.log(`  (no footprint)            —                    ${row.partNumber}`);
    continue;
  }
  const entry = pinoutCache[footprint];
  if (!entry) {
    console.log(`  MISSING                  ${footprint.padEnd(20)} ${row.partNumber}`);
    findings.push({ area: "pinout_cache", part: row.partNumber, detail: `no entry for ${footprint}` });
    continue;
  }
  const named = entry.ok ? Object.keys(entry.pins).length : 0;
  const pads = entry.padCount ?? 0;
  const ratio = pads ? named / pads : 0;
  const flag = named === 0 ? "  <- no named pins" : ratio < 0.5 ? "  <- sparsely named" : "";
  console.log(`  ${String(named).padStart(3)}/${String(pads).padEnd(4)}    ${footprint.padEnd(20)} ${row.partNumber}${flag}`);
  if (named === 0 || ratio < 0.5) {
    findings.push({
      area: "pinout_cache_sparse",
      part: row.partNumber,
      detail: `${named}/${pads} pads carry names`,
      footprint,
    });
  }
}

// ---------------------------------------------------------------------------
// 4. Pin resolution outcome per part
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(80)}\n4. PIN RESOLUTION\n${"=".repeat(80)}`);
let realPins = 0;
let totalPins = 0;
for (const row of rows) {
  const entries = [...row.pins.entries()];
  const real = entries.filter(([, d]) => d.real);
  realPins += real.length;
  totalPins += entries.length;
  const curated = curatedPinout(row.partNumber, row.package);
  console.log(
    `  ${String(real.length)}/${String(entries.length)}  ${row.partNumber.padEnd(22)} ` +
      `${real.map(([p, d]) => `${p}=${d.pad}`).join(" ") || "(none)"}` +
      (curated.ok ? "   [curated pinout]" : "")
  );
}

console.log(`\n${"=".repeat(80)}\nTOTALS: ${realPins}/${totalPins} logical pins real across ${rows.length} distinct parts`);

// ---------------------------------------------------------------------------
// 4b. Unresolved pins, shown against the pins the part actually has.
//
// This is what makes an "unresolved" count meaningful rather than a blob: a pin
// the part does not physically have is an UPSTREAM data error and will never
// resolve, while a pin that exists under a port name needs a datasheet mux
// table. Those are different problems with different owners.
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(80)}\n4b. UNRESOLVED PINS vs WHAT THE PART ACTUALLY EXPOSES\n${"=".repeat(80)}`);
for (const row of rows) {
  const unresolved = [...row.pins.entries()].filter(([, d]) => !d.real).map(([p]) => p);
  if (unresolved.length === 0) continue;
  const footprint = row.resolution.footprint.value;
  const entry = footprint ? pinoutCache[footprint] : null;
  const available = entry?.ok ? Object.keys(entry.pins) : [];
  console.log(`  ${row.partNumber}`);
  console.log(`     unresolved: ${unresolved.join(", ")}`);
  console.log(
    `     part has  : ${available.length ? available.join(", ").slice(0, 100) : "(no named pins in catalogue)"}`
  );
}

// ---------------------------------------------------------------------------
// 5. 3D model availability (optional compile probe)
// ---------------------------------------------------------------------------
if (probe3d) {
  console.log(`\n${"=".repeat(80)}\n5. 3D MODEL AVAILABILITY (compile probe)\n${"=".repeat(80)}`);
  const { CircuitRunner } = await import("@tscircuit/eval");
  for (const row of rows) {
    const footprint = row.resolution.footprint.value;
    if (!footprint) {
      console.log(`  (no footprint)  ${row.partNumber}`);
      continue;
    }
    try {
      const runner = new CircuitRunner();
      await runner.execute(
        `circuit.add(<board width="40mm" height="40mm"><chip name="U1" footprint=${JSON.stringify(footprint)} /></board>)`
      );
      await runner.renderUntilSettled();
      const circuitJson = await runner.getCircuitJson();
      const cad = circuitJson.filter((el) => el.type === "cad_component");
      const withUrl = cad.filter(
        (c) => c.model_obj_url || c.model_stl_url || c.model_gltf_url || c.model_glb_url
      );
      const status = withUrl.length > 0 ? "MODEL" : cad.length > 0 ? "cad, no url" : "NONE";
      console.log(`  ${status.padEnd(12)} ${row.partNumber.padEnd(22)} ${footprint}`);
      if (withUrl.length === 0) {
        findings.push({ area: "model_3d", part: row.partNumber, detail: `${status} for ${footprint}` });
      }
    } catch (error) {
      console.log(`  ERROR        ${row.partNumber}: ${String(error.message).slice(0, 60)}`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(80)}\nFINDINGS: ${findings.length}\n${"=".repeat(80)}`);
for (const finding of findings) {
  console.log(`  [${finding.area}] ${finding.part}: ${finding.detail}`);
}
if (findings.length === 0) console.log("  none — every checked dependency is complete for the fixture parts.");

fs.writeFileSync(
  path.join(dataDir, "cache-audit-report.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), realPins, totalPins, findings }, null, 2)}\n`
);
