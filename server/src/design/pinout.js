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
 * Cross-name rail equivalences. Deliberately limited to the two that are
 * genuinely universal: VSS is ground, VCC and VDD are the same supply-naming
 * convention.
 *
 * ── Deliberately NOT included ───────────────────────────────────────────────
 * `VDDA` / `AGND` / `DGND` / `GNDA` are **separate rails**, not aliases. On a
 * mixed-signal part the analog supply is filtered separately from the digital
 * one, so wiring a digital VDD to VDDA is an electrical error that renders
 * perfectly. This previously mapped `FS32K116LFT0MLFT`'s VDD to `VDDA` (pin 6)
 * when `VDD1` (pin 5) existed.
 *
 * `VIN` is also excluded: on a converter or charger the input supply is not the
 * device's own VDD rail. `TP4110` has `VIN` and no VDD, and the honest answer
 * there is PIN_NOT_FOUND rather than a plausible-looking wrong pin. (D-032)
 */
const RAIL_EQUIVALENTS = Object.freeze({
  GND: ["GND", "VSS"],
  VSS: ["VSS", "GND"],
  VDD: ["VDD", "VCC"],
  VCC: ["VCC", "VDD"],
});

/**
 * Many parts split a rail across numbered pins (`GND1..GND5`, `VDD1`/`VDD2`,
 * `VSS1`/`VSS2`). Those are the SAME net, so a logical `GND` legitimately
 * matches `GND1`. Applies to power/ground rails only — a numbered suffix on a
 * signal pin (`DIO11`, `OUT3`) means a different signal, never an alias.
 */
const numberedVariants = (base, available) =>
  available
    .filter((name) => new RegExp(`^${base}\\d+$`).test(name))
    .sort((a, b) => Number(a.slice(base.length)) - Number(b.slice(base.length)));

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
  const available = Object.keys(pins);
  const wanted = String(logicalPin).toUpperCase();

  // 1. Exact name.
  if (wanted in pins) {
    return { ok: true, pad: pins[wanted], matchedName: wanted, via: "exact" };
  }

  const equivalents = RAIL_EQUIVALENTS[wanted];

  // 2. Numbered variant of the same rail (GND -> GND1). Only for rails.
  if (equivalents) {
    const [first] = numberedVariants(wanted, available);
    if (first) {
      return {
        ok: true,
        pad: pins[first],
        matchedName: first,
        via: "numbered_rail",
        reason: `"${wanted}" matched "${first}" — a numbered pin of the same rail`,
      };
    }
  }

  // 3. Equivalent rail name, exact then numbered (GND -> VSS, then VSS1).
  for (const candidate of equivalents ?? []) {
    const key = candidate.toUpperCase();
    if (key in pins) {
      return {
        ok: true,
        pad: pins[key],
        matchedName: key,
        via: "synonym",
        reason: `"${wanted}" matched pin "${key}" (standard rail equivalence)`,
      };
    }
    const [firstNumbered] = numberedVariants(key, available);
    if (firstNumbered) {
      return {
        ok: true,
        pad: pins[firstNumbered],
        matchedName: firstNumbered,
        via: "numbered_rail",
        reason:
          `"${wanted}" matched "${firstNumbered}" — a numbered pin of the ` +
          `equivalent rail "${key}"`,
      };
    }
  }

  return {
    ok: false,
    message: `no pin named "${wanted}" on this part`,
    availablePins: available.sort(),
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
