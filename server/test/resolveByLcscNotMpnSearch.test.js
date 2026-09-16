/**
 * GUARD: when a component carries an `lcsc`, resolution must query by that
 * catalogue number and NEVER fall back to the MPN free-text search.
 *
 * The defect this guards: jlcsearch's free-text index does not retrieve short
 * hyphenated module names by their own name. "ESP-F" (C19949062, 853 in stock)
 * returns LM393DR2G and other comparators at result limits of 5, 20 AND 100, so
 * the part resolved COMPONENT_NOT_FOUND despite existing in the catalogue.
 * ESP-M1 (C19949056) and BLE-SER-A-ANT (C2829462) failed identically. Raising
 * the limit rescues only ESP-M1; the other two never appear at any limit.
 *
 * Upstream already knows these numbers -- dunkai records one on every
 * shortlisted candidate -- so once pcb_ir forwards it, the MPN re-derivation is
 * unnecessary. The MPN path is KEPT for components that arrive without one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolvePart, PARTS_CACHE_PATH } from "../src/design/partsEngine.js";

/** Run resolvePart against a stubbed fetch, with the real cache side-stepped. */
async function withStubbedApi(responder, fn) {
  const realFetch = globalThis.fetch;
  const realCache = fs.existsSync(PARTS_CACHE_PATH)
    ? fs.readFileSync(PARTS_CACHE_PATH, "utf8")
    : null;
  const queries = [];
  globalThis.fetch = async (url) => {
    const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
    queries.push(q);
    return { ok: true, json: async () => responder(q) };
  };
  // Start from an empty cache so the stub is actually exercised.
  fs.mkdirSync(path.dirname(PARTS_CACHE_PATH), { recursive: true });
  fs.writeFileSync(PARTS_CACHE_PATH, "{}\n");
  try {
    return { result: await fn(), queries };
  } finally {
    globalThis.fetch = realFetch;
    if (realCache !== null) fs.writeFileSync(PARTS_CACHE_PATH, realCache);
    else fs.rmSync(PARTS_CACHE_PATH, { force: true });
  }
}

// The real ESP-F situation: findable by catalogue number, invisible by name.
const ESP_F = { lcsc: 19949062, mfr: "ESP-F", package: "SMD,24x16mm", stock: 853, description: "" };
const COMPARATORS = [
  { lcsc: 7955, mfr: "LM393DR2G", package: "SOIC-8", stock: 344596, description: "" },
  { lcsc: 57474, mfr: "LM2903DR2G", package: "SOIC-8", stock: 326868, description: "" },
];
const respond = (q) => ({ components: q === "C19949062" ? [ESP_F] : COMPARATORS });

test("a component WITH an lcsc resolves by catalogue number", async () => {
  const { result, queries } = await withStubbedApi(respond, () =>
    resolvePart({ ref_id: "U2", part_number: "ESP-F", package: "SMD,24x16mm", lcsc: "C19949062" })
  );
  assert.equal(result.ok, true, `expected resolution, got: ${result.message}`);
  assert.equal(result.lcsc, "C19949062");
  assert.equal(result.footprint, "jlcpcb:C19949062");
  assert.deepEqual(queries, ["C19949062"], "must query by lcsc only");
});

test("...and NEVER issues the MPN free-text query", async () => {
  const { queries } = await withStubbedApi(respond, () =>
    resolvePart({ ref_id: "U2", part_number: "ESP-F", package: "SMD,24x16mm", lcsc: "C19949062" })
  );
  assert.ok(!queries.includes("ESP-F"),
    `MPN search must not run when an lcsc is present; queries were ${JSON.stringify(queries)}`);
  assert.equal(queries.length, 1, "exactly one lookup");
});

test("without an lcsc the MPN path is UNCHANGED — and still fails for ESP-F", async () => {
  const { result, queries } = await withStubbedApi(respond, () =>
    resolvePart({ ref_id: "U2", part_number: "ESP-F", package: "SMD,24x16mm" })
  );
  assert.deepEqual(queries, ["ESP-F"], "must fall back to the MPN query");
  assert.equal(result.ok, false);
  assert.equal(result.code, "COMPONENT_NOT_FOUND");
  assert.match(result.message, /part number "ESP-F"/,
    "a no-lcsc failure must still name the part number, not an lcsc");
});

test("the MPN path still RESOLVES a part the index can find", async () => {
  const good = { lcsc: 19949072, mfr: "ESPC3-12-N4", package: "SMD,24x16mm", stock: 445, description: "" };
  const { result, queries } = await withStubbedApi(
    (q) => ({ components: q === "ESPC3-12-N4" ? [good] : [] }),
    () => resolvePart({ ref_id: "U2", part_number: "ESPC3-12-N4", package: "SMD,24x16mm" })
  );
  assert.deepEqual(queries, ["ESPC3-12-N4"]);
  assert.equal(result.ok, true);
  assert.equal(result.lcsc, "C19949072");
});

test("package is still enforced when resolving by lcsc", async () => {
  // The catalogue number does NOT license accepting a different physical part.
  const { result } = await withStubbedApi(respond, () =>
    resolvePart({ ref_id: "U2", part_number: "ESP-F", package: "QFN-32", lcsc: "C19949062" })
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /no entry matches package "QFN-32"/);
  assert.equal(result.detail.packageMismatches.length, 1,
    "the near miss must be reported, not silently dropped");
});

test("an lcsc that does not exist fails naming the LCSC, not the MPN", async () => {
  const { result } = await withStubbedApi(
    () => ({ components: [] }),
    () => resolvePart({ ref_id: "U9", part_number: "BT2S", package: "-", lcsc: "C3034204" })
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /No catalogue entry for LCSC C3034204/,
    "a genuine catalogue gap must be diagnosable as an LCSC miss");
});

test("lcsc-keyed and mpn-keyed lookups do not share a cache entry", async () => {
  // Same MPN+package, different lookup, different failure mode -- they must not
  // collide, or one would silently serve the other's cached result.
  const seen = [];
  await withStubbedApi(
    (q) => { seen.push(q); return respond(q); },
    async () => {
      await resolvePart({ ref_id: "U2", part_number: "ESP-F", package: "SMD,24x16mm", lcsc: "C19949062" });
      await resolvePart({ ref_id: "U2", part_number: "ESP-F", package: "SMD,24x16mm" });
    }
  );
  assert.deepEqual(seen, ["C19949062", "ESP-F"],
    "both lookups must reach the API; a shared cache key would suppress the second");
});
