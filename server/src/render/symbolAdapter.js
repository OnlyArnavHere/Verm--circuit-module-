/**
 * Adapter from the `schematic-symbols` library (351 real EE symbols) to SVG
 * fragments we can place on our own canvas.
 *
 * Symbols are defined in millimetre-ish units around an origin, as lists of
 * primitives (`path`, `circle`, `text`) plus named `ports`. We scale, translate,
 * and emit plain SVG — no dependency on tscircuit's renderer.
 */
import { symbols } from "schematic-symbols";

/** Symbols we actually use. Named here so a library rename fails loudly. */
export const SYMBOL_NAMES = Object.freeze({
  GROUND: "ground_down",
  VCC: "vcc_up",
});

export function getSymbol(name) {
  const symbol = symbols[name];
  if (!symbol) {
    throw new Error(
      `schematic-symbols has no symbol "${name}". Available count: ${Object.keys(symbols).length}.`
    );
  }
  return symbol;
}

const num = (n) => (Math.abs(n) < 1e-9 ? 0 : Number(n.toFixed(3)));

/**
 * Render a symbol centered at (cx, cy), scaled by `scale` px per symbol unit.
 * Y is flipped: symbol space is Y-up, SVG is Y-down.
 */
export function renderSymbol(name, { cx, cy, scale = 26, stroke = "#1a1a1a", strokeWidth = 1.6 }) {
  const symbol = getSymbol(name);
  const toX = (x) => num(cx + x * scale);
  const toY = (y) => num(cy - y * scale);

  const parts = [];

  for (const primitive of symbol.primitives ?? []) {
    if (primitive.type === "path" && primitive.points?.length) {
      const d = primitive.points
        .map((p, i) => `${i === 0 ? "M" : "L"}${toX(p.x)} ${toY(p.y)}`)
        .join(" ");
      parts.push(
        `<path d="${d}" fill="${primitive.fill ? stroke : "none"}" ` +
          `stroke="${stroke}" stroke-width="${strokeWidth}" ` +
          `stroke-linecap="round" stroke-linejoin="round"/>`
      );
    } else if (primitive.type === "circle") {
      parts.push(
        `<circle cx="${toX(primitive.x)}" cy="${toY(primitive.y)}" ` +
          `r="${num(primitive.radius * scale)}" ` +
          `fill="${primitive.fill ? stroke : "none"}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`
      );
    }
    // `text` primitives are intentionally skipped — the symbol's own built-in
    // labels ("GND", "V+") are re-drawn by the caller at our chosen font size.
  }

  return parts.join("");
}

/** Where a symbol's connection point sits, in our canvas coordinates. */
export function symbolPort(name, { cx, cy, scale = 26 }, portIndex = 0) {
  const symbol = getSymbol(name);
  const port = symbol.ports?.[portIndex];
  if (!port) throw new Error(`Symbol "${name}" has no port ${portIndex}.`);
  return { x: num(cx + port.x * scale), y: num(cy - port.y * scale) };
}
