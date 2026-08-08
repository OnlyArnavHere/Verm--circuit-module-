/**
 * Deterministic circuit-diagram renderer (required output #1).
 *
 * This is NOT the schematic (output #2). The schematic is tscircuit's formal
 * capture: every pin, pad numbers, net labels. The circuit diagram is the
 * decluttered view — the thing a person points at to understand the design:
 *
 *   - only pins that actually participate in a net are drawn
 *   - grounds become ground symbols, not a giant GND net box
 *   - power becomes a labelled rail with drops, not N pairwise wires
 *   - connections are orthogonal wire-style polylines with junction dots
 *
 * Determinism: layout depends only on (part_class, ref_id) ordering and net
 * name ordering. No randomness, no timestamps, no layout solver. Same input =>
 * byte-identical SVG.
 *
 * Symbols come from `schematic-symbols` (the same library tscircuit uses), so
 * the ground/VCC glyphs are real EE symbols rather than shapes we invented.
 */
import { renderSymbol, symbolPort, SYMBOL_NAMES } from "./symbolAdapter.js";

// ---------------------------------------------------------------------------
// Geometry constants. All px. Tuned so a 3-8 component board reads clearly.
// ---------------------------------------------------------------------------
const BLOCK_W = 158;
const PIN_SLOT = 26; // vertical spacing between pin stubs on a block edge
const BLOCK_MIN_H = 84;
const BLOCK_HEADER = 46; // space for ref + part number before pins start
const STUB = 30; // length of the pin stub sticking out of the block
const COL_GAP = 210; // gutter between columns, holds routing channels
const MARGIN_X = 90;
const RAIL_TOP_PAD = 74; // distance from canvas top to the power rail
const BLOCK_TOP_PAD = 150; // distance from canvas top to the first block
const GND_DROP = 60; // distance from block bottom to the ground symbol
// Must clear the ground symbol AND its label, or a block's ground drops onto the
// block stacked beneath it in the same column.
const ROW_GAP = GND_DROP + 96;
// Power drops descend in a lane outside the block's own width, so a drop never
// crosses a block sitting above it in the same column.
const POWER_LANE_OFFSET = 56;

const INK = "#1a1a1a";
const WIRE = "#1a5e8a";
const POWER = "#b3261e";
const GROUND = "#3a3a3a";
const MUTED = "#6b6b6b";
const BLOCK_FILL = "#fdfbf4";
const BLOCK_STROKE = "#8a6d3b";

/**
 * Which column a part_class lives in. Sources on the left, the brain in the
 * middle, sinks/peripherals on the right — the conventional reading order for
 * a circuit diagram.
 */
const COLUMN_OF = {
  power: 0,
  sensor: 0,
  input: 0,
  processing: 1,
  communication: 2,
  output: 2,
  storage: 2,
  clock: 2,
};

/** Draw order within a column. Lower sorts first (higher on the page). */
const CLASS_ORDER = {
  power: 0,
  sensor: 1,
  input: 2,
  processing: 0,
  communication: 0,
  output: 1,
  storage: 2,
  clock: 3,
};

/** A small glyph per class so blocks are visually distinguishable at a glance. */
const CLASS_GLYPH = {
  processing: "MCU",
  sensor: "SENSOR",
  output: "OUT",
  communication: "COMM",
  power: "PWR",
  storage: "MEM",
  clock: "CLK",
  input: "IN",
};

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n = (v) => Number(v.toFixed(2));

/**
 * @param {object} design Upstream-shaped design: { design_name, components, nets }
 * @returns {string} SVG document
 */
export function renderCircuitDiagram(design) {
  const components = [...(design.components ?? [])].sort((a, b) => {
    const ca = COLUMN_OF[a.part_class] ?? 1;
    const cb = COLUMN_OF[b.part_class] ?? 1;
    if (ca !== cb) return ca - cb;
    const oa = CLASS_ORDER[a.part_class] ?? 9;
    const ob = CLASS_ORDER[b.part_class] ?? 9;
    if (oa !== ob) return oa - ob;
    return a.ref_id.localeCompare(b.ref_id);
  });

  const nets = [...(design.nets ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  // --- classify nets -------------------------------------------------------
  const groundPins = new Map(); // ref_id -> pin name
  const powerPins = new Map();
  const signalNets = [];

  for (const net of nets) {
    const parsed = (net.connections ?? [])
      .map((c) => {
        const [ref, pin] = String(c).split(".");
        return { ref, pin };
      })
      .filter((p) => p.ref && p.pin);

    if (net.net_class === "ground") {
      for (const p of parsed) groundPins.set(p.ref, p.pin);
    } else if (net.net_class === "power") {
      for (const p of parsed) if (!powerPins.has(p.ref)) powerPins.set(p.ref, p.pin);
    } else {
      signalNets.push({ ...net, parsed });
    }
  }

  // --- assign pin stubs per component --------------------------------------
  const byRef = new Map(components.map((c) => [c.ref_id, c]));
  const columnOf = (ref) => COLUMN_OF[byRef.get(ref)?.part_class] ?? 1;

  /** ref -> { left: [pinName], right: [pinName] } preserving deterministic order */
  const stubs = new Map(components.map((c) => [c.ref_id, { left: [], right: [] }]));

  for (const net of signalNets) {
    for (const { ref, pin } of net.parsed) {
      if (!stubs.has(ref)) continue;
      // Put the stub on the side facing the net's other endpoint.
      const peers = net.parsed.filter((p) => p.ref !== ref);
      const peerCol = peers.length ? columnOf(peers[0].ref) : columnOf(ref);
      const side = peerCol < columnOf(ref) ? "left" : "right";
      const list = stubs.get(ref)[side];
      if (!list.includes(pin)) list.push(pin);
    }
  }

  // --- lay out blocks ------------------------------------------------------
  const rawColumns = [[], [], []];
  for (const component of components) {
    rawColumns[COLUMN_OF[component.part_class] ?? 1].push(component);
  }
  // Drop empty columns so a design with no right-hand parts doesn't render a
  // wide band of dead space.
  const columns = rawColumns.filter((col) => col.length > 0);

  const blocks = new Map();
  const columnX = (index) => MARGIN_X + index * (BLOCK_W + COL_GAP);

  for (let ci = 0; ci < columns.length; ci++) {
    let y = BLOCK_TOP_PAD;
    for (const component of columns[ci]) {
      const s = stubs.get(component.ref_id);
      const pinRows = Math.max(s.left.length, s.right.length);
      const height = Math.max(BLOCK_MIN_H, BLOCK_HEADER + pinRows * PIN_SLOT + 16);
      blocks.set(component.ref_id, {
        component,
        x: columnX(ci),
        y,
        w: BLOCK_W,
        h: height,
        col: ci,
      });
      y += height + ROW_GAP;
    }
  }

  const allBlocks = [...blocks.values()];
  // The power rail and its VCC glyph extend further left than any block, so
  // bounds are computed from drawn content, not from the block grid.
  const contentMinX = Math.min(
    ...allBlocks.map((b) => b.x - POWER_LANE_OFFSET - 58),
    ...allBlocks.map((b) => b.x - STUB - 12)
  );
  const shiftX = MARGIN_X - contentMinX;
  const canvasW =
    Math.max(...allBlocks.map((b) => b.x + b.w + STUB + 60)) + shiftX + MARGIN_X;
  const canvasH = Math.max(...allBlocks.map((b) => b.y + b.h)) + GND_DROP + 74;

  /** Absolute position of a named pin stub's outer end. */
  const stubPoint = (ref, pin) => {
    const block = blocks.get(ref);
    if (!block) return null;
    const s = stubs.get(ref);
    const li = s.left.indexOf(pin);
    const ri = s.right.indexOf(pin);
    if (li === -1 && ri === -1) return null;
    const side = li !== -1 ? "left" : "right";
    const index = li !== -1 ? li : ri;
    const y = block.y + BLOCK_HEADER + index * PIN_SLOT + PIN_SLOT / 2;
    return side === "left"
      ? { x: block.x - STUB, y, side, edgeX: block.x }
      : { x: block.x + block.w + STUB, y, side, edgeX: block.x + block.w };
  };

  // ---------------------------------------------------------------------------
  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(canvasW)} ${n(canvasH)}" ` +
      `width="${n(canvasW)}" height="${n(canvasH)}" font-family="ui-sans-serif, system-ui, sans-serif">`
  );
  out.push(`<rect width="100%" height="100%" fill="#fffdf7"/>`);
  out.push(
    `<text x="${MARGIN_X}" y="34" font-size="19" font-weight="600" fill="${INK}">` +
      `${esc(design.design_name ?? "circuit")} — circuit diagram</text>`
  );
  // Everything below is laid out in block coordinates; shift it into view.
  out.push(`<g transform="translate(${n(shiftX)} 0)">`);

  // --- power rail ----------------------------------------------------------
  const railY = RAIL_TOP_PAD;
  const poweredBlocks = [...blocks.values()].filter((b) => powerPins.has(b.component.ref_id));

  if (poweredBlocks.length > 0) {
    const laneX = (block) => block.x - POWER_LANE_OFFSET;
    const lanes = poweredBlocks.map(laneX);
    const railFrom = Math.min(...lanes) - 40;
    const railTo = Math.max(...lanes) + 40;

    out.push(
      `<line x1="${n(railFrom)}" y1="${railY}" x2="${n(railTo)}" y2="${railY}" ` +
        `stroke="${POWER}" stroke-width="3"/>`
    );
    out.push(renderSymbol(SYMBOL_NAMES.VCC, { cx: railFrom, cy: railY, scale: 34, stroke: POWER, strokeWidth: 2.4 }));
    out.push(
      `<text x="${n(railFrom)}" y="${n(railY - 26)}" font-size="13" font-weight="600" ` +
        `fill="${POWER}" text-anchor="middle">+3V3</text>`
    );

    for (const block of poweredBlocks) {
      const lane = laneX(block);
      const entryX = block.x + 26; // enters the block's top edge, left of the notch
      const jogY = block.y - 18;

      // rail -> down the lane -> across -> down into the block's top edge
      out.push(
        `<path d="M${n(lane)} ${railY} L${n(lane)} ${n(jogY)} L${n(entryX)} ${n(jogY)} ` +
          `L${n(entryX)} ${n(block.y)}" fill="none" stroke="${POWER}" stroke-width="2" ` +
          `stroke-linejoin="round"/>`
      );
      out.push(`<circle cx="${n(lane)}" cy="${railY}" r="3.6" fill="${POWER}"/>`);
      out.push(
        `<text x="${n(entryX + 6)}" y="${n(block.y - 5)}" font-size="10.5" fill="${POWER}">` +
          `${esc(powerPins.get(block.component.ref_id))}</text>`
      );
    }
  }

  // --- signal wires (drawn under the blocks so blocks stay readable) -------
  const junctions = new Map(); // "x,y" -> count
  const netLabels = []; // drawn last, so blocks never cover them

  signalNets.forEach((net, netIndex) => {
    const points = net.parsed.map((p) => ({ ...p, pt: stubPoint(p.ref, p.pin) })).filter((p) => p.pt);
    if (points.length < 2) return;

    // Route each pair through a vertical channel in the gutter, offset per net
    // so parallel nets don't overlap. Deterministic: keyed on sorted net order.
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i].pt;
      const b = points[i + 1].pt;
      const channelBase = (a.x + b.x) / 2;
      const channel = channelBase + ((netIndex % 5) - 2) * 17;

      const d =
        `M${n(a.x)} ${n(a.y)} L${n(channel)} ${n(a.y)} ` +
        `L${n(channel)} ${n(b.y)} L${n(b.x)} ${n(b.y)}`;
      out.push(
        `<path d="${d}" fill="none" stroke="${WIRE}" stroke-width="2" ` +
          `stroke-linejoin="round" stroke-linecap="round"/>`
      );

      for (const pt of [a, b]) {
        const key = `${n(pt.x)},${n(pt.y)}`;
        junctions.set(key, (junctions.get(key) ?? 0) + 1);
      }
    }

    // Net name, placed at the midpoint of the first hop.
    const first = points[0].pt;
    const second = points[1].pt;
    const labelX = (first.x + second.x) / 2 + ((netIndex % 5) - 2) * 17;
    // Stagger vertically: nets sharing an origin pin (e.g. two buses both landing
    // on U1.MOSI) would otherwise print their labels on top of each other.
    const labelY = Math.min(first.y, second.y) - 7 - (netIndex % 3) * 13;
    netLabels.push(
      `<text x="${n(labelX)}" y="${n(labelY)}" font-size="10.5" fill="${WIRE}" ` +
        `text-anchor="middle" font-weight="500" paint-order="stroke" ` +
        `stroke="#fffdf7" stroke-width="3.5">${esc(net.name)}</text>`
    );
  });

  // --- ground symbols ------------------------------------------------------
  for (const block of blocks.values()) {
    const pin = groundPins.get(block.component.ref_id);
    if (!pin) continue;
    const x = block.x + block.w / 2;
    const bottom = block.y + block.h;
    const gndY = bottom + GND_DROP;

    out.push(
      `<line x1="${n(x)}" y1="${n(bottom)}" x2="${n(x)}" y2="${n(gndY)}" ` +
        `stroke="${GROUND}" stroke-width="2"/>`
    );
    out.push(renderSymbol(SYMBOL_NAMES.GROUND, { cx: x, cy: gndY, scale: 40, stroke: GROUND, strokeWidth: 2.2 }));
    out.push(
      `<text x="${n(x + 8)}" y="${n(bottom + 15)}" font-size="10.5" fill="${MUTED}">${esc(pin)}</text>`
    );
  }

  // --- component blocks ----------------------------------------------------
  for (const block of blocks.values()) {
    const { component: c, x, y, w, h } = block;
    const s = stubs.get(c.ref_id);

    out.push(
      `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="3" ` +
        `fill="${BLOCK_FILL}" stroke="${BLOCK_STROKE}" stroke-width="2"/>`
    );
    // Pin-1 notch, the visual cue that this is an IC.
    out.push(
      `<path d="M${n(x + w / 2 - 9)} ${n(y)} A 9 9 0 0 0 ${n(x + w / 2 + 9)} ${n(y)}" ` +
        `fill="none" stroke="${BLOCK_STROKE}" stroke-width="1.6"/>`
    );

    out.push(
      `<text x="${n(x + w / 2)}" y="${n(y + 24)}" font-size="17" font-weight="700" ` +
        `fill="${INK}" text-anchor="middle">${esc(c.ref_id)}</text>`
    );
    out.push(
      `<text x="${n(x + w / 2)}" y="${n(y + 38)}" font-size="9.5" fill="${MUTED}" ` +
        `text-anchor="middle">${esc(c.part_number)}</text>`
    );
    out.push(
      `<text x="${n(x + 7)}" y="${n(y + h - 7)}" font-size="8.5" fill="${BLOCK_STROKE}" ` +
        `font-weight="600" letter-spacing="0.5">${esc(CLASS_GLYPH[c.part_class] ?? "IC")}</text>`
    );

    for (const [side, list] of [["left", s.left], ["right", s.right]]) {
      list.forEach((pin, index) => {
        const py = y + BLOCK_HEADER + index * PIN_SLOT + PIN_SLOT / 2;
        const x1 = side === "left" ? x : x + w;
        const x2 = side === "left" ? x - STUB : x + w + STUB;
        out.push(
          `<line x1="${n(x1)}" y1="${n(py)}" x2="${n(x2)}" y2="${n(py)}" ` +
            `stroke="${INK}" stroke-width="1.8"/>`
        );
        out.push(
          `<text x="${n(side === "left" ? x + 7 : x + w - 7)}" y="${n(py - 4)}" ` +
            `font-size="10" fill="${INK}" text-anchor="${side === "left" ? "start" : "end"}">${esc(pin)}</text>`
        );
      });
    }
  }

  // --- junction dots -------------------------------------------------------
  for (const [key, count] of junctions) {
    if (count < 2) continue;
    const [jx, jy] = key.split(",").map(Number);
    out.push(`<circle cx="${jx}" cy="${jy}" r="3.4" fill="${WIRE}"/>`);
  }

  out.push(...netLabels);

  out.push("</g>");
  out.push("</svg>");
  return out.join("\n");
}
