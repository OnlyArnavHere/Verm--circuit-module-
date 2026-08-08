/**
 * Phase 5.5 — DRC is wired in, and `DRC_FAILURE` is a live path in the taxonomy
 * rather than a code that can never fire.
 *
 * Fixtures are REAL compiled output from deliberately-bad boards (two chips
 * stacked at the same coordinates; a chip placed off the board).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDrc } from "../src/design/drc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = async (name) =>
  JSON.parse(await fs.readFile(path.join(here, "fixtures", name), "utf8"));

test("DRC_FAILURE fires on a deliberately-bad board (overlapping components)", async () => {
  const drc = await runDrc(await load("circuitjson-drc-overlap.json"));

  assert.equal(drc.ran, true, "the DRC suite must actually run");
  assert.ok(drc.errors.length > 0, "overlapping footprints must produce failures");

  const codes = new Set(drc.errors.map((e) => e.code));
  assert.ok(codes.has("DRC_FAILURE"), "at least one finding must be DRC_FAILURE");

  const types = Object.keys(drc.byType);
  assert.ok(
    types.some((t) => /overlap|clearance/.test(t)),
    `expected an overlap/clearance finding, got: ${types.join(", ")}`
  );
});

test("a component off the board maps to BOARD_CONSTRAINT_FAILURE, not DRC_FAILURE", async () => {
  const drc = await runDrc(await load("circuitjson-drc-outside-board.json"));

  const outside = drc.errors.find((e) => e.detail.drcType === "pcb_component_outside_board_error");
  assert.ok(outside, "the off-board component must be reported");
  assert.equal(
    outside.code,
    "BOARD_CONSTRAINT_FAILURE",
    "placement outside the outline is a board-constraint failure, not a DRC rule violation"
  );
});

test("advisory findings are warnings, so a board is not failed for them", async () => {
  // The POC fixtures produce only advisory findings (underspecified pins, no
  // declared power/ground pin) — those must not become DRC_FAILURE.
  const drc = await runDrc(await load("circuitjson-healthy-sot23.json"));

  assert.equal(drc.ran, true);
  assert.equal(drc.errors.length, 0, "a clean board must produce no DRC_FAILURE");
  for (const warning of drc.warnings) {
    assert.equal(warning.severity, "warning");
    assert.match(warning.detail.drcType, /_warning$/);
  }
});

test("runDrc awaits the check suite", async () => {
  // runAllChecks is async: calling it without await yields a Promise that looks
  // like an empty result and silently reports "no findings". This asserts the
  // real, awaited result.
  const drc = await runDrc(await load("circuitjson-drc-overlap.json"));
  assert.equal(typeof drc.total, "number");
  assert.ok(drc.total > 0, "findings must be counted, not lost to a pending Promise");
});

test("an empty design does not crash the DRC stage", async () => {
  const drc = await runDrc([]);
  assert.equal(drc.ran, true);
  assert.equal(drc.errors.length, 0);
});
