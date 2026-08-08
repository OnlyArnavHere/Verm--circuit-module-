/**
 * Phase 2 empirical check #2:
 *   A. Is output deterministic across repeated runs? (plan question 5)
 *   B. What happens with parts/footprints tscircuit does not know? (question 3)
 *
 * (B) matters most: PROJECT_PLAN section 4 forbids silent guessing. We need to
 * know whether tscircuit throws, records a warning, or quietly emits a
 * plausible-looking-but-wrong artifact.
 *
 * Run: node determinism-and-failures.js
 */
import crypto from "node:crypto";
import { CircuitRunner } from "@tscircuit/eval";
import { convertCircuitJsonToPcbSvg, convertCircuitJsonToSchematicSvg } from "circuit-to-svg";

const sha = (s) =>
  crypto.createHash("sha256").update(typeof s === "string" ? s : JSON.stringify(s)).digest("hex");

async function build(source) {
  const runner = new CircuitRunner();
  await runner.execute(source);
  await runner.renderUntilSettled();
  return runner.getCircuitJson();
}

const KNOWN_GOOD = `
circuit.add(
  <board width="100mm" height="60mm">
    <chip name="U1" footprint="soic16" pcbX={-30} />
    <chip name="U2" footprint="qfn48"  pcbX={0} />
    <chip name="U3" footprint="qfn16"  pcbX={30} />
    <trace from=".U1 > .pin1" to=".U2 > .pin1" />
  </board>
)
`;

console.log("A. DETERMINISM\n" + "=".repeat(72));

const runs = [];
for (let i = 0; i < 3; i++) {
  const cj = await build(KNOWN_GOOD);
  runs.push({
    circuitJson: sha(cj),
    pcbSvg: sha(convertCircuitJsonToPcbSvg(cj)),
    schSvg: sha(convertCircuitJsonToSchematicSvg(cj)),
  });
}

for (const key of ["circuitJson", "pcbSvg", "schSvg"]) {
  const hashes = runs.map((r) => r[key]);
  const identical = hashes.every((h) => h === hashes[0]);
  console.log(
    `${identical ? "STABLE  " : "VARIES  "} ${key.padEnd(12)} ${hashes[0].slice(0, 20)}${
      identical ? "" : `\n         differs: ${hashes.map((h) => h.slice(0, 12)).join(" / ")}`
    }`
  );
}

// Are ids stable, or are there random/uuid-ish or timestamp fields?
const cj = await build(KNOWN_GOOD);
const idSample = cj
  .filter((el) => el.pcb_component_id || el.source_component_id)
  .slice(0, 3)
  .map((el) => el.pcb_component_id ?? el.source_component_id);
console.log(`\nid sample: ${JSON.stringify(idSample)}`);
const raw = JSON.stringify(cj);
console.log(`contains ISO timestamp: ${/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)}`);
console.log(`contains uuid v4 shape: ${/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}/.test(raw)}`);

console.log("\n\nB. FAILURE MODES WITH UNKNOWN PARTS\n" + "=".repeat(72));

/** Real part numbers + packages straight out of our test-fixtures. */
const CASES = [
  {
    name: "nonexistent footprint name",
    source: `circuit.add(<board width="20mm" height="20mm"><chip name="U1" footprint="totally_not_a_real_footprint_xyz" /></board>)`,
  },
  {
    name: "fixture package string as footprint (MAPBGA-289)",
    source: `circuit.add(<board width="40mm" height="40mm"><chip name="U1" footprint="MAPBGA-289" /></board>)`,
  },
  {
    name: "fixture package string as footprint (QFN-16-EP(4x4))",
    source: `circuit.add(<board width="20mm" height="20mm"><chip name="U1" footprint="QFN-16-EP(4x4)" /></board>)`,
  },
  {
    name: "no footprint at all",
    source: `circuit.add(<board width="20mm" height="20mm"><chip name="U1" /></board>)`,
  },
  {
    name: "trace to a pin that does not exist",
    source: `circuit.add(<board width="20mm" height="20mm"><chip name="U1" footprint="soic8" /><chip name="U2" footprint="soic8" /><trace from=".U1 > .pin99" to=".U2 > .pin1" /></board>)`,
  },
];

for (const testCase of CASES) {
  let verdict;
  try {
    const result = await build(testCase.source);

    const errors = result.filter((el) => String(el.type).includes("error"));
    const warnings = result.filter((el) => String(el.type).includes("warning"));
    const pads = result.filter((el) => el.type === "pcb_smtpad" || el.type === "pcb_plated_hole");

    verdict =
      `elements=${String(result.length).padEnd(4)} pads=${String(pads.length).padEnd(4)} ` +
      `errors=${errors.length} warnings=${warnings.length}`;

    if (errors.length > 0) {
      verdict += `\n         error types: ${[...new Set(errors.map((e) => e.type))].join(", ")}`;
      verdict += `\n         message: ${String(errors[0].message ?? errors[0].error_type).slice(0, 120)}`;
    }
    // The dangerous case: no error surfaced AND no pads generated.
    if (errors.length === 0 && pads.length === 0) {
      verdict += "\n         *** SILENT: no error element, no pads — would ship an empty footprint ***";
    }
  } catch (error) {
    verdict = `THREW ${error.constructor.name}: ${String(error.message).slice(0, 140)}`;
  }
  console.log(`\n${testCase.name}\n         ${verdict}`);
}

console.log("\n" + "=".repeat(72));
