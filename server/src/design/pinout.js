/**
 * Real pinout resolution from the parts catalogue.
 *
 * Catalogue footprints carry the part's actual pin names as `port_hints` — e.g.
 * LDC1314RGHR exposes SCL, SDA, VDD, GND, ADDR, INTB. So a logical pin from the
 * Hardware Agent (`U3.SCL`) can be mapped to a real physical pad by NAME, rather
 * than assigned positionally as a mock.
 *
 * Extraction requires compiling a one-chip board per part (~4s), so results are
 * cached on disk alongside the parts cache (D-011).
 *
 * ── Matching rules ──────────────────────────────────────────────────────────
 * - Exact name match  -> real.
 * - Curated synonym   -> real, but only for universally standard equivalences
 *                        (VSS=GND, VCC=VDD). Each carries a reason.
 * - Anything else     -> unresolved. No fuzzy matching, no "closest" pin.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.resolve(here, "../../data/pinout-cache.json");

/**
 * Standard equivalences only. These are universal in datasheets, not guesses:
 * VSS/GND are the same rail, VCC/VDD are the same supply pin naming convention.
 * Do NOT extend this with part-specific hunches.
 */
const SYNONYMS = Object.freeze({
  GND: ["GND", "VSS", "AGND", "DGND", "GNDA"],
  VDD: ["VDD", "VCC", "VDDA", "VIN", "V+"],
  VSS: ["VSS", "GND"],
  VCC: ["VCC", "VDD"],
});

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  const sorted = Object.fromEntries(
    Object.entries(cache).sort(([a], [b]) => a.localeCompare(b))
  );
  fs.writeFileSync(CACHE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
}

/**
 * Compile a one-chip board and read the real pin names out of its source ports.
 * @returns {Promise<{ok: boolean, pins?: object, padCount?: number, message?: string}>}
 */
export async function extractPinout(footprint, { allowNetwork = true } = {}) {
  const cache = loadCache();
  if (Object.prototype.hasOwnProperty.call(cache, footprint)) {
    return { ...cache[footprint], cached: true };
  }
  if (!allowNetwork) {
    return { ok: false, message: `pinout for ${footprint} not cached and network disabled` };
  }

  let result;
  try {
    const { CircuitRunner } = await import("@tscircuit/eval");
    const runner = new CircuitRunner();
    await runner.execute(
      `circuit.add(<board width="60mm" height="60mm"><chip name="PROBE" footprint=${JSON.stringify(footprint)} /></board>)`
    );
    await runner.renderUntilSettled();
    const circuitJson = await runner.getCircuitJson();

    const ports = circuitJson.filter((el) => el.type === "source_port");
    /** real pin name (upper) -> canonical pad selector (pinN) */
    const pins = {};

    for (const port of ports) {
      const padName = port.name; // always "pinN"
      for (const hint of port.port_hints ?? []) {
        const text = String(hint);
        // Skip the positional aliases ("pin7", "7") — we want the real names.
        if (/^pin\d+$/i.test(text) || /^\d+$/.test(text)) continue;
        const key = text.toUpperCase();
        // First hint wins so the mapping is stable across runs.
        if (!(key in pins)) pins[key] = padName;
      }
    }

    result = {
      ok: Object.keys(pins).length > 0,
      pins,
      padCount: ports.length,
      message: Object.keys(pins).length > 0 ? undefined : "footprint exposes no named pins",
    };
  } catch (error) {
    // Transient failures are not cached.
    return { ok: false, message: `pinout extraction failed: ${error.message}`, transient: true };
  }

  cache[footprint] = result;
  saveCache(cache);
  return { ...result, cached: false };
}

/**
 * Map one logical pin name onto a real pad.
 * @returns {{ok: true, pad: string, matchedName: string, via: "exact"|"synonym", reason?: string}
 *          |{ok: false, message: string, availablePins: string[]}}
 */
export function matchLogicalPin(logicalPin, pinout) {
  const pins = pinout?.pins ?? {};
  const wanted = String(logicalPin).toUpperCase();

  if (wanted in pins) {
    return { ok: true, pad: pins[wanted], matchedName: wanted, via: "exact" };
  }

  for (const candidate of SYNONYMS[wanted] ?? []) {
    const key = candidate.toUpperCase();
    if (key in pins) {
      return {
        ok: true,
        pad: pins[key],
        matchedName: key,
        via: "synonym",
        reason: `"${wanted}" matched pin "${key}" (standard equivalence)`,
      };
    }
  }

  return {
    ok: false,
    message: `no pin named "${wanted}" on this part`,
    availablePins: Object.keys(pins).sort(),
  };
}

export function pinoutCacheStats() {
  const cache = loadCache();
  const entries = Object.values(cache);
  return {
    total: entries.length,
    resolved: entries.filter((e) => e.ok).length,
    path: CACHE_PATH,
  };
}
