/**
 * Phase 3 / Phase 5 error-by-code breakdown for one fixture.
 *
 * Reproduces the `verified_counts` block recorded in the dunkai_real_v* fixture
 * provenance: phase3 buildValidatedDesign errors, phase5 resolveComponents
 * errors tallied by code, and the per-pin `why` reason tally.
 *
 * Usage: node scripts/phase5-breakdown.mjs <fixture-name>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildValidatedDesign } from "../src/design/validatedDesign.js";
import { resolveComponents } from "../src/design/resolver.js";
import { resolverNets } from "./resolver-nets.js";
import { isSchemaV2 } from "../src/design/normalizeUpstream.js";
import { installHttpCache } from "../src/services/httpCache.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../test-fixtures");
const name = process.argv[2];
if (!name) {
  console.error("usage: node scripts/phase5-breakdown.mjs <fixture-name>");
  process.exit(2);
}

installHttpCache({ mode: "readwrite" });

const upstream = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, `${name}.json`), "utf8")
);

const validated = buildValidatedDesign(upstream);

// Role-based nets, NOT the flattened "REF.PIN" strings. This script previously
// copied that pattern from run-poc.js, so every Phase 5 number it produced for a
// schema-2.0 fixture measured a resolver lookup for a pin literally named
// "null" -- one guaranteed error per component, independent of part selection.
// See scripts/resolver-nets.js.
const nets = resolverNets(upstream, validated.design, isSchemaV2);

const resolution = await resolveComponents(upstream.components, nets);

const tally = (list, key) => {
  const out = {};
  for (const item of list) {
    const k = item?.[key] ?? "(none)";
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort());
};

// The per-pin `why` reason lives on each error's detail; fall back to the code
// when a given error carries no finer reason.
const whyList = (resolution.errors ?? []).map((e) => ({
  why: e.why ?? e.reason_code ?? e.detail?.why ?? e.code,
}));

const result = {
  fixture: name,
  phase3_buildValidatedDesign_errors: (validated.errors ?? []).length,
  phase5_resolveComponents_errors: (resolution.errors ?? []).length,
  phase5_by_code: tally(resolution.errors ?? [], "code"),
  why_each_pin_failed: tally(whyList, "why"),
};

console.log(JSON.stringify(result, null, 1));
