/**
 * Phase 6 — one pin appearing in multiple named nets.
 *
 * `gas_leakage_detector.json` wires `U1.GPIO1` into both `GPIO_5` and `GPIO_6`.
 * The split-bus check deliberately skips non-bus roles (a driver fanning out to
 * several loads is legal), so this shape was previously not reported at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runElectricalChecks } from "../src/design/electricalChecks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = async (name) =>
  JSON.parse(
    await fs.readFile(path.resolve(here, `../../test-fixtures/${name}.json`), "utf8")
  );

test("gas_leakage_detector: U1.GPIO1 in two nets is reported", async () => {
  const { errors } = runElectricalChecks(await load("gas_leakage_detector"));

  const finding = errors.find((e) => e.code === "INVALID_NET" && e.target === "U1.GPIO1");
  assert.ok(finding, "U1.GPIO1 appears in GPIO_5 and GPIO_6 and must be flagged");
  assert.deepEqual(finding.detail.nets.sort(), ["GPIO_5", "GPIO_6"]);
  // The actionable part: what it would look like as one correct net.
  assert.deepEqual(finding.detail.endpointsIfMerged.sort(), [
    "U1.GPIO1",
    "U6.GPIO1",
    "U7.GPIO1",
  ]);
});

test("the merge is proposed, never auto-applied", async () => {
  const { modifications } = runElectricalChecks(await load("gas_leakage_detector"));
  const proposal = modifications.find((m) => m.detectedBy === "PIN_IN_MULTIPLE_NETS");

  assert.ok(proposal);
  assert.equal(proposal.correctedValue, null, "must not silently merge");
  assert.ok(proposal.originalValue, "original connections retained");
  assert.match(proposal.reason, /NOT auto-applied/);
});

test("it is reported distinctly from the split-bus case", async () => {
  // U1.SDA (bus) and U1.GPIO1 (fan-out) need different fixes, so they must not
  // be reported by the same rule.
  const noise = runElectricalChecks(await load("noise_pollution_monitor"));
  const busFinding = noise.modifications.find((m) => m.detectedBy === "SPLIT_BUS_HALF_NETS");
  assert.ok(busFinding, "the I2C split-bus case still uses the bus rule");

  const gas = runElectricalChecks(await load("gas_leakage_detector"));
  const fanoutFinding = gas.modifications.find((m) => m.detectedBy === "PIN_IN_MULTIPLE_NETS");
  assert.ok(fanoutFinding, "the GPIO case uses the fan-out rule");
});

test("a pin used once is not flagged", () => {
  const { errors } = runElectricalChecks({
    nets: [
      { name: "N1", connections: ["U1.GPIO1", "U2.GPIO1"], net_class: "signal" },
      { name: "N2", connections: ["U1.GPIO2", "U3.GPIO1"], net_class: "signal" },
    ],
  });
  assert.deepEqual(errors, [], "distinct pins in distinct nets are correct");
});

test("ground and power nets are exempt — sharing those pins is normal", () => {
  const { errors } = runElectricalChecks({
    nets: [
      { name: "GND", connections: ["U1.GND", "U2.GND"], net_class: "ground" },
      { name: "GND_2", connections: ["U1.GND", "U3.GND"], net_class: "ground" },
      { name: "PWR", connections: ["U1.VDD", "U2.VDD"], net_class: "power" },
      { name: "PWR_2", connections: ["U1.VDD", "U3.VDD"], net_class: "power" },
    ],
  });
  assert.deepEqual(
    errors.filter((e) => e.code === "INVALID_NET"),
    [],
    "rail nets legitimately share pins and are de-duplicated elsewhere"
  );
});
