/**
 * Parts-engine resolution: manufacturer part number -> LCSC code -> footprint.
 *
 * Backed by the unauthenticated jlcsearch API (https://jlcsearch.tscircuit.com),
 * which indexes the JLCPCB/EasyEDA catalogue that tscircuit's `jlcpcb:` footprint
 * prefix reads from.
 *
 * ── Two rules this module enforces ──────────────────────────────────────────
 *
 * 1. **Package must match exactly.** A catalogue hit on the part number is not
 *    enough. If upstream says `QFN-16-EP(4x4)` and the catalogue returns a part
 *    in `QFN-16(4x4)`, that is the same lookalike substitution `footprintMap`
 *    exists to prevent — it is rejected, not warned about.
 *
 * 2. **Results are cached on disk** (D-011). Live lookups take 2-4s per part,
 *    need network, and can change upstream — all three break the determinism rule
 *    in PROJECT_PLAN §0. Caching pins a part number to one resolution forever and
 *    lets a re-run work offline.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.resolve(here, "../../data/parts-cache.json");
const API = "https://jlcsearch.tscircuit.com/api/search";

export const PARTS_CACHE_PATH = CACHE_PATH;

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  // Sorted keys so the committed cache diffs cleanly.
  const sorted = Object.fromEntries(
    Object.entries(cache).sort(([a], [b]) => a.localeCompare(b))
  );
  fs.writeFileSync(CACHE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
}

// The lcsc is part of the key: the same MPN+package resolved WITH a catalogue
// number and WITHOUT one are different lookups with different failure modes,
// and must not share a cache entry.
const cacheKey = (partNumber, pkg, lcsc) =>
  lcsc ? `${partNumber}::${pkg}::${lcsc}` : `${partNumber}::${pkg}`;

/** Normalize for comparison without being lenient about real differences. */
const normalizePackage = (pkg) => String(pkg ?? "").trim().replace(/\s+/g, "").toUpperCase();

/**
 * Resolve a part against the catalogue.
 *
 * @param {{part_number: string, package: string}} component
 * @param {{allowNetwork?: boolean}} options
 * @returns {Promise<{ok: true, lcsc: string, footprint: string, package: string,
 *                    expectedPadCount: null, description: string, stock: number,
 *                    cached: boolean}
 *                  |{ok: false, code: string, message: string, detail: object}>}
 */
export async function resolvePart(component, { allowNetwork = true } = {}) {
  const partNumber = String(component.part_number ?? "").trim();
  const pkg = String(component.package ?? "").trim();

  if (!partNumber) {
    return {
      ok: false,
      code: "COMPONENT_NOT_FOUND",
      message: "No part_number supplied; cannot query the parts engine.",
      detail: {},
    };
  }

  const lcscKey = String(component.lcsc ?? "").trim();
  const cache = loadCache();
  const key = cacheKey(partNumber, pkg, lcscKey);

  if (Object.prototype.hasOwnProperty.call(cache, key)) {
    const hit = cache[key];
    return hit.ok
      ? { ...hit, cached: true }
      : { ...hit, cached: true };
  }

  if (!allowNetwork) {
    return {
      ok: false,
      code: "COMPONENT_NOT_FOUND",
      message:
        `"${partNumber}" is not in the parts cache and network lookups are disabled.`,
      detail: { partNumber, package: pkg },
    };
  }

  // Prefer a KNOWN-GOOD identifier over re-deriving one from the MPN string.
  //
  // Upstream already knows the catalogue number -- dunkai records it on every
  // shortlisted candidate -- and since the pcb_ir handoff now forwards it, the
  // MPN->LCSC re-derivation is unnecessary whenever `lcsc` is present. That
  // re-derivation goes through jlcsearch's free-text index, which does NOT
  // retrieve short hyphenated module names by their own name: "ESP-F"
  // (C19949062, 853 in stock) returns LM393DR2G and other comparators at
  // result limits of 5, 20 AND 100, so the part resolved COMPONENT_NOT_FOUND
  // despite existing. ESP-M1 and BLE-SER-A-ANT failed the same way. Raising
  // the limit rescues only ESP-M1; the other two never appear at all.
  //
  // The MPN path below is KEPT, not replaced: a component may legitimately
  // arrive with no lcsc (any upstream that does not run dunkai's shortlist
  // step), and that case must resolve exactly as it did before.
  const lcsc = String(component.lcsc ?? "").trim();
  const query = lcsc || partNumber;

  let payload;
  try {
    const response = await fetch(
      `${API}?q=${encodeURIComponent(query)}&limit=5`,
      { signal: AbortSignal.timeout(20000) }
    );
    if (!response.ok) {
      return {
        ok: false,
        code: "COMPONENT_NOT_FOUND",
        message: `Parts engine returned HTTP ${response.status} for "${partNumber}".`,
        detail: { partNumber, status: response.status },
      };
    }
    payload = await response.json();
  } catch (error) {
    // A network failure is NOT a resolution failure — do not cache it, or a
    // transient outage would poison the cache permanently.
    return {
      ok: false,
      code: "COMPONENT_NOT_FOUND",
      message: `Parts engine unreachable for "${partNumber}": ${error.message}`,
      detail: { partNumber, transient: true },
    };
  }

  const candidates = payload?.components ?? [];

  // With an lcsc, match on the CATALOGUE NUMBER -- the identifier the query was
  // built from. Package is still checked, so a mismatched package is still
  // reported rather than silently accepted; the number does not license
  // skipping that.
  //
  // Without one, the original behaviour: exact MPN, then exact package.
  const exact = lcsc
    ? candidates.filter((c) => `C${c.lcsc}`.toUpperCase() === lcsc.toUpperCase())
    : candidates.filter(
        (c) => String(c.mfr ?? "").trim().toUpperCase() === partNumber.toUpperCase()
      );

  const matched = exact.find(
    (c) => normalizePackage(c.package) === normalizePackage(pkg)
  );

  let result;
  if (matched) {
    result = {
      ok: true,
      lcsc: `C${matched.lcsc}`,
      footprint: `jlcpcb:C${matched.lcsc}`,
      package: matched.package,
      description: matched.description ?? "",
      stock: matched.stock ?? 0,
      matchedOn: "part_number+package",
    };
  } else {
    // Record *why* it failed, including near misses, so the agent layer can explain.
    const packageMismatches = exact.map((c) => ({
      lcsc: `C${c.lcsc}`,
      package: c.package,
      blocker: `package "${c.package}" does not match upstream "${pkg}"`,
    }));

    // Name what was actually looked up, so a failure is diagnosable: "no entry
    // for LCSC C123" and "no entry for part number FOO" are different problems.
    const what = lcsc ? `LCSC ${lcsc}` : `part number "${partNumber}"`;

    result = {
      ok: false,
      code: "COMPONENT_NOT_FOUND",
      message:
        exact.length === 0
          ? `No catalogue entry for ${what}.`
          : `Found ${what} in the catalogue but no entry matches package "${pkg}". ` +
            `Not substituted — a different package is a different physical part.`,
      detail: { partNumber, lcsc: lcsc || null, package: pkg, packageMismatches },
    };
  }

  cache[key] = result;
  saveCache(cache);
  return { ...result, cached: false };
}

/** Resolve many parts, de-duplicating identical (part_number, package) pairs. */
export async function resolveParts(components, options = {}) {
  const results = new Map();
  for (const component of components) {
    const key = cacheKey(component.part_number, component.package);
    if (results.has(key)) continue;
    results.set(key, await resolvePart(component, options));
  }
  return results;
}

export function cacheStats() {
  const cache = loadCache();
  const entries = Object.values(cache);
  return {
    total: entries.length,
    resolved: entries.filter((e) => e.ok).length,
    unresolved: entries.filter((e) => !e.ok).length,
    path: CACHE_PATH,
  };
}
