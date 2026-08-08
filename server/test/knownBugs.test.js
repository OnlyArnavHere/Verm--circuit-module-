/**
 * The four known bugs from PROJECT_PLAN §1, asserted against the real fixture
 * data. These must be caught, not passed through silently.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runElectricalChecks } from "../src/design/electricalChecks.js";
import { buildValidatedDesign } from "../src/design/validatedDesign.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = async (name) =>
  JSON.parse(
    await fs.readFile(path.resolve(here, `../../test-fixtures/${name}.json`), "utf8")
  );

test("BUG 1 — smart_dustbin SPI_10 ties U7.SCK to U1.MOSI", async () => {
  const { errors } = runElectricalChecks(await load("smart_dustbin"));
  const found = errors.find(
    (e) => e.code === "ELECTRICAL_CONFLICT" && e.target === "nets.SPI_10"
  );
  assert.ok(found, "SPI_10 clock/data conflict must be caught");
  assert.deepEqual(found.detail.conflict.sort(), ["U1.MOSI", "U7.SCK"]);
});

test("BUG 2 — noise_pollution_monitor has the SCK/MOSI pattern twice", async () => {
  const { errors } = runElectricalChecks(await load("noise_pollution_monitor"));
  const spi = errors.filter(
    (e) => e.code === "ELECTRICAL_CONFLICT" && /nets\.SPI_(8|10)$/.test(e.target)
  );
  assert.equal(spi.length, 2, "both SPI_8 and SPI_10 must be caught");
  assert.deepEqual(spi.map((e) => e.target).sort(), ["nets.SPI_10", "nets.SPI_8"]);
});

test("BUG 3 — I2C_7 and I2C_11 are disconnected half-nets sharing U1.SDA", async () => {
  const { errors } = runElectricalChecks(await load("noise_pollution_monitor"));
  const split = errors.find((e) => e.code === "INVALID_NET" && e.target === "U1.SDA");
  assert.ok(split, "the split bus must be caught");
  assert.deepEqual(split.detail.nets.sort(), ["I2C_11", "I2C_7"]);
});

test("BUG 4 — redundant POWER_n nets are removed, and recorded", async () => {
  for (const name of ["smart_dustbin", "noise_pollution_monitor"]) {
    const { design, modifications } = buildValidatedDesign(await load(name));

    const remaining = design.nets.map((n) => n.name).filter((n) => /^POWER_\d+$/.test(n));
    assert.deepEqual(remaining, [], `${name}: no redundant POWER_n should survive`);
    assert.ok(
      design.nets.some((n) => n.name === "POWER_RAIL_3V3"),
      `${name}: the superset rail survives`
    );

    const removals = modifications.filter(
      (m) => m.detectedBy === "NET_SUBSUMED_BY_LARGER_NET"
    );
    assert.ok(removals.length > 0, `${name}: removals must be recorded`);
    for (const modification of removals) {
      assert.ok(modification.originalValue, "original connections preserved");
      assert.ok(modification.reason, "a reason is required");
    }
  }
});

test("corrections are proposed, never auto-applied", async () => {
  const { modifications } = runElectricalChecks(await load("smart_dustbin"));
  const conflict = modifications.find((m) => m.detectedBy === "CLOCK_TIED_TO_DATA_PIN");
  assert.ok(conflict);
  assert.equal(conflict.correctedValue, null, "must not silently reroute");
  assert.ok(conflict.originalValue, "original value is retained");
  assert.match(conflict.reason, /NOT auto-applied/);
});

test("a clean design produces no electrical findings", () => {
  const { errors } = runElectricalChecks({
    nets: [
      { name: "I2C", connections: ["U1.SDA", "U2.SDA"], net_class: "signal" },
      { name: "I2C_CLK", connections: ["U1.SCL", "U2.SCL"], net_class: "signal" },
    ],
  });
  assert.deepEqual(errors, [], "correctly-wired buses must not be flagged");
});
