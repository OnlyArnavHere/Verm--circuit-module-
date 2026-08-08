import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFootprint } from "../src/design/footprintMap.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../test-fixtures");

/** The 10 distinct package strings across all four fixtures. */
async function fixturePackages() {
  const files = (await fs.readdir(fixturesDir)).filter((f) => f.endsWith(".json"));
  const packages = new Set();
  for (const file of files) {
    const design = JSON.parse(await fs.readFile(path.join(fixturesDir, file), "utf8"));
    for (const component of design.components) packages.add(component.package);
  }
  return [...packages];
}

test("resolves SOT-23-6 to a verified footprint with an expected pad count", () => {
  const result = resolveFootprint("SOT-23-6");
  assert.equal(result.ok, true);
  assert.equal(result.footprint, "sot23_6");
  assert.equal(result.expectedPadCount, 6);
  assert.ok(result.evidence, "a curated entry must carry evidence");
});

test("every other fixture package returns FOOTPRINT_NOT_FOUND, never a guess", async () => {
  const packages = await fixturePackages();
  const unresolved = packages.filter((p) => p !== "SOT-23-6");

  assert.ok(unresolved.length >= 9, `expected >=9 unresolved packages, got ${unresolved.length}`);

  for (const pkg of unresolved) {
    const result = resolveFootprint(pkg);
    assert.equal(result.ok, false, `${pkg} must not resolve`);
    assert.equal(result.code, "FOOTPRINT_NOT_FOUND");
    assert.equal(
      result.footprint,
      undefined,
      `${pkg} must not carry a substituted footprint`
    );
  }
});

test("DFN-8-EP(2x3) is refused, and its zero-pad danger is recorded", () => {
  // Phase 2 R1: tscircuit parses this with zero errors and zero pads.
  const result = resolveFootprint("DFN-8-EP(2x3)");
  assert.equal(result.ok, false);
  assert.equal(result.code, "FOOTPRINT_NOT_FOUND");
  assert.match(result.message, /ZERO PADS/i);
});

test("near-miss candidates are surfaced but never auto-selected", () => {
  const result = resolveFootprint("SOIC-8");
  assert.equal(result.ok, false);
  assert.ok(result.candidates.length > 0, "SOIC-8 has a known candidate");
  assert.equal(result.candidates[0].footprint, "soic8");
  assert.ok(result.candidates[0].blocker, "a candidate must say why it is not used");
  // Surfacing is not resolving.
  assert.equal(result.ok, false);
});

test("pad-count agreement alone does not promote a candidate", () => {
  // ssop24 really does produce 24 pads, matching SSOP-24's implied pin count.
  // That is still not proof of matching geometry, so it must not resolve.
  const result = resolveFootprint("SSOP-24");
  assert.equal(result.ok, false);
  assert.equal(result.candidates[0].padCount, 24);
});

test("empty or missing package strings fail explicitly", () => {
  for (const bad of ["", "   ", null, undefined]) {
    const result = resolveFootprint(bad);
    assert.equal(result.ok, false);
    assert.equal(result.code, "FOOTPRINT_NOT_FOUND");
  }
});

test("whitespace variations of a curated package still resolve", () => {
  assert.equal(resolveFootprint("  SOT-23-6  ").ok, true);
});
