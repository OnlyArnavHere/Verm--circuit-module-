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
import { renderPartIcon, PART_CLASSES, partClassStyle } from "../src/render/partIcons.js";

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

// ---------------------------------------------------------------------------
// Icon reference sheet — the 8 part_class icons, for the approach doc.
// ---------------------------------------------------------------------------
const CELL = 132;
const sheetW = PART_CLASSES.length * CELL;
const sheetH = 178;

const sheet = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sheetW} ${sheetH}" ` +
    `width="${sheetW}" height="${sheetH}" font-family="ui-sans-serif, system-ui, sans-serif">`,
  `<rect width="100%" height="100%" fill="#fffdf7"/>`,
];

PART_CLASSES.forEach((partClass, index) => {
  const cx = CELL / 2 + index * CELL;
  const style = partClassStyle(partClass);
  sheet.push(
    `<rect x="${cx - 54}" y="16" width="108" height="108" rx="14" fill="#ffffff" stroke="#ddd8cd"/>`,
    `<path d="M${cx - 42} 16 H${cx + 42} A 12 12 0 0 1 ${cx + 54} 28 V31 H${cx - 54} V28 A 12 12 0 0 1 ${cx - 42} 16 Z" fill="${style.stroke}" opacity="0.85"/>`,
    renderPartIcon(partClass, { cx, cy: 78, size: 60 }),
    `<text x="${cx}" y="148" font-size="13" text-anchor="middle" fill="#1a1a1a" font-weight="600">${partClass}</text>`,
    `<text x="${cx}" y="165" font-size="11" text-anchor="middle" fill="${style.stroke}">${style.label}</text>`
  );
});
sheet.push("</svg>");

const sheetSvg = sheet.join("\n");
fs.writeFileSync(path.join(outDir, "part-class-icons.svg"), sheetSvg);
fs.writeFileSync(
  path.join(outDir, "part-class-icons.png"),
  new Resvg(sheetSvg, { background: "white", fitTo: { mode: "width", value: 1400 } })
    .render()
    .asPng()
);
console.log(`icon sheet: ${PART_CLASSES.length} part_class icons`);
