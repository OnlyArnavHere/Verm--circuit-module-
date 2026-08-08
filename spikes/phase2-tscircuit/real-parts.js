/**
 * Phase 2 empirical check #3 — the real-part path (plan question 3).
 *
 * Our fixtures carry manufacturer part numbers (MIMXRT1172CVM8A) and package
 * strings (MAPBGA-289), NOT tscircuit footprint names. This measures the gap.
 *
 * Also sanity-checks that the generated SVGs contain real geometry rather than
 * being technically-valid but blank.
 *
 * Run WITH network: node real-parts.js
 */
import fs from "node:fs";
import path from "node:path";
import { CircuitRunner } from "@tscircuit/eval";
import { convertCircuitJsonToPcbSvg, convertCircuitJsonToSchematicSvg } from "circuit-to-svg";

async function build(source) {
  const runner = new CircuitRunner();
  await runner.execute(source);
  await runner.renderUntilSettled();
  return runner.getCircuitJson();
}

const summarize = (cj) => {
  const errors = cj.filter((el) => String(el.type).includes("error"));
  const pads = cj.filter((el) => el.type === "pcb_smtpad" || el.type === "pcb_plated_hole");
  return { errors, pads, count: cj.length };
};

console.log("A. FOOTPRINTER built-in footprints (offline, no network)\n" + "=".repeat(72));

// footprinter is the built-in generator: parametric names like "qfn48_p0.5"
const BUILTIN = ["soic8", "soic16", "qfn16", "qfn48", "lqfp48", "lqfp32", "sot23", "bga289"];
for (const fp of BUILTIN) {
  const cj = await build(
    `circuit.add(<board width="40mm" height="40mm"><chip name="U1" footprint="${fp}" /></board>)`
  );
  const { errors, pads } = summarize(cj);
  console.log(
    `${errors.length === 0 ? "OK  " : "ERR "} ${fp.padEnd(12)} pads=${String(pads.length).padEnd(4)}` +
      (errors.length ? ` ${String(errors[0].message).slice(0, 80)}` : "")
  );
}

console.log("\n\nB. FIXTURE package strings, used verbatim\n" + "=".repeat(72));
const FIXTURE_PACKAGES = [
  "SOP-16",
  "MAPBGA-289",
  "QFN-16-EP(4x4)",
  "LQFP-48(7x7)",
  "SOIC-8",
  "SOT-23-6",
  "SSOP-24",
  "DFN-8-EP(2x3)",
  "SMD,15.2x11.2mm",
  "DIP-18",
];
for (const pkg of FIXTURE_PACKAGES) {
  const cj = await build(
    `circuit.add(<board width="40mm" height="40mm"><chip name="U1" footprint=${JSON.stringify(pkg)} /></board>)`
  );
  const { errors, pads } = summarize(cj);
  console.log(
    `${errors.length === 0 ? "OK  " : "ERR "} ${pkg.padEnd(18)} pads=${String(pads.length).padEnd(4)}` +
      (errors.length ? ` ${String(errors[0].type)}` : "")
  );
}

console.log("\n\nC. jlcpcb: parts-engine lookup (NEEDS NETWORK)\n" + "=".repeat(72));
for (const ref of ["jlcpcb:C2040", "jlcpcb:C7420051"]) {
  const started = Date.now();
  try {
    const cj = await build(
      `circuit.add(<board width="40mm" height="40mm"><chip name="U1" footprint="${ref}" /></board>)`
    );
    const { errors, pads } = summarize(cj);
    console.log(
      `${errors.length === 0 ? "OK  " : "ERR "} ${ref.padEnd(20)} pads=${String(pads.length).padEnd(4)} ` +
        `${Date.now() - started}ms` +
        (errors.length ? `\n     ${String(errors[0].message ?? errors[0].type).slice(0, 150)}` : "")
    );
  } catch (error) {
    console.log(`THREW ${ref}: ${String(error.message).slice(0, 150)}`);
  }
}

console.log("\n\nD. SVG content sanity (is it real geometry or a blank canvas?)\n" + "=".repeat(72));
const cj = await build(`
circuit.add(
  <board width="100mm" height="60mm">
    <chip name="U1" footprint="soic16" pcbX={-30} schX={-6} />
    <chip name="U2" footprint="qfn48"  pcbX={0}  schX={0} />
    <chip name="U3" footprint="qfn16"  pcbX={30} schX={6} />
    <trace from=".U1 > .pin1" to=".U2 > .pin1" />
    <trace from=".U2 > .pin2" to=".U3 > .pin1" />
  </board>
)`);

const outDir = path.join(import.meta.dirname, "out");
fs.mkdirSync(outDir, { recursive: true });

for (const [name, svg] of [
  ["pcb", convertCircuitJsonToPcbSvg(cj)],
  ["schematic", convertCircuitJsonToSchematicSvg(cj)],
]) {
  const paths = (svg.match(/<path/g) ?? []).length;
  const rects = (svg.match(/<rect/g) ?? []).length;
  const texts = (svg.match(/<text/g) ?? []).length;
  const circles = (svg.match(/<circle/g) ?? []).length;
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1] ?? "none";
  fs.writeFileSync(path.join(outDir, `sanity-${name}.svg`), svg);
  console.log(
    `${name.padEnd(10)} viewBox=${viewBox.padEnd(28)} ` +
      `path=${paths} rect=${rects} text=${texts} circle=${circles}`
  );
  // Do the component names actually appear as labels?
  const labelled = ["U1", "U2", "U3"].filter((n) => svg.includes(`>${n}<`) || svg.includes(n));
  console.log(`${" ".repeat(10)} component refs present in SVG: ${labelled.join(", ") || "NONE"}`);
}
