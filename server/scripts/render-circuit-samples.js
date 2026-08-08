/**
 * Renders the circuit-diagram output for the test fixtures, as SVG and PNG.
 * Used to produce the samples referenced by docs/CIRCUIT_DIAGRAM_APPROACH.md.
 *
 * Usage: node scripts/render-circuit-samples.js [fixture ...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { renderCircuitDiagram } from "../src/render/circuitDiagram.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../test-fixtures");
const outDir = path.resolve(here, "../../docs/samples");
fs.mkdirSync(outDir, { recursive: true });

const names =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

for (const name of names) {
  const design = JSON.parse(
    fs.readFileSync(path.join(fixturesDir, `${name}.json`), "utf8")
  );
  const svg = renderCircuitDiagram(design);
  fs.writeFileSync(path.join(outDir, `circuit-${name}.svg`), svg);

  const png = new Resvg(svg, {
    background: "white",
    fitTo: { mode: "width", value: 1400 },
  })
    .render()
    .asPng();
  fs.writeFileSync(path.join(outDir, `circuit-${name}.png`), png);

  console.log(`${name}: ${svg.length} B svg, ${png.length} B png`);
}
