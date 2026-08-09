/**
 * Stylized part-class icons for the pictorial circuit diagram (Phase 7).
 *
 * ── Original art, deliberately ──────────────────────────────────────────────
 * These are hand-authored flat-style glyphs drawn on a 24x24 grid. They do NOT
 * copy or imitate Fritzing, Arduino, Tinkercad, or any other vendor's board
 * artwork — that would be an IP problem, not merely a style risk. They are
 * generic category glyphs: a chip, a wave-emitting sensor, a screen, an antenna,
 * a battery, a memory stack, a clock face, a button.
 *
 * ── One icon per part_class, not per part ───────────────────────────────────
 * There is no meaningful pictorial for a bare 289-ball BGA, so the icon
 * represents the *category*. Eight classes, eight icons, cached and reused
 * across every design — a one-time asset cost.
 */

/**
 * Per-class palette and label. Colours are chosen to stay distinguishable from
 * the wire colours (see WIRE_COLORS in circuitDiagram.js) so a part never reads
 * as a net.
 */
export const PART_CLASS_STYLE = Object.freeze({
  processing: { fill: "#e8e6fb", stroke: "#4f46b8", label: "Microcontroller" },
  sensor: { fill: "#dff3f1", stroke: "#0f766e", label: "Sensor" },
  output: { fill: "#fdefd6", stroke: "#b45309", label: "Output" },
  communication: { fill: "#f0e6fa", stroke: "#7c3aed", label: "Comms" },
  power: { fill: "#fbe3e0", stroke: "#b3261e", label: "Power" },
  storage: { fill: "#efe7dd", stroke: "#8a5a2b", label: "Storage" },
  clock: { fill: "#e2f2e4", stroke: "#2f7d3a", label: "Clock" },
  input: { fill: "#fce7ef", stroke: "#b5306b", label: "Input" },
});

const FALLBACK = { fill: "#eceff3", stroke: "#4a5568", label: "Component" };

export const partClassStyle = (partClass) => PART_CLASS_STYLE[partClass] ?? FALLBACK;

/**
 * Icon geometry, authored in a 24x24 box. Each entry returns the inner SVG
 * markup; `s` is the stroke colour, `f` the fill.
 */
const ICONS = {
  // A chip: square die with leads on all four sides and a pin-1 dot.
  processing: (s, f) =>
    `<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="${f}" stroke="${s}" stroke-width="1.4"/>
     <rect x="9.5" y="9.5" width="5" height="5" rx="0.6" fill="none" stroke="${s}" stroke-width="1"/>
     ${[9, 12, 15]
       .map(
         (y) =>
           `<line x1="3.6" y1="${y}" x2="6.5" y2="${y}" stroke="${s}" stroke-width="1.4" stroke-linecap="round"/>
            <line x1="17.5" y1="${y}" x2="20.4" y2="${y}" stroke="${s}" stroke-width="1.4" stroke-linecap="round"/>`
       )
       .join("")}
     ${[9, 12, 15]
       .map(
         (x) =>
           `<line x1="${x}" y1="3.6" x2="${x}" y2="6.5" stroke="${s}" stroke-width="1.4" stroke-linecap="round"/>
            <line x1="${x}" y1="17.5" x2="${x}" y2="20.4" stroke="${s}" stroke-width="1.4" stroke-linecap="round"/>`
       )
       .join("")}
     <circle cx="8.4" cy="8.4" r="0.85" fill="${s}"/>`,

  // A sensing element emitting detection waves.
  sensor: (s, f) =>
    `<rect x="4" y="12.5" width="16" height="7.5" rx="1.8" fill="${f}" stroke="${s}" stroke-width="1.4"/>
     <circle cx="12" cy="16.25" r="2" fill="none" stroke="${s}" stroke-width="1.3"/>
     ${[3.5, 6.2, 8.9]
       .map(
         (r) =>
           `<path d="M ${12 - r} 10.4 A ${r} ${r} 0 0 1 ${12 + r} 10.4" fill="none" stroke="${s}" stroke-width="1.3" stroke-linecap="round" opacity="${1 - (r - 3.5) * 0.13}"/>`
       )
       .join("")}`,

  // A display panel on a stand.
  output: (s, f) =>
    `<rect x="3.5" y="4.5" width="17" height="11.5" rx="1.6" fill="${f}" stroke="${s}" stroke-width="1.4"/>
     <line x1="6.6" y1="8.2" x2="17.4" y2="8.2" stroke="${s}" stroke-width="1.2" stroke-linecap="round"/>
     <line x1="6.6" y1="10.8" x2="14.6" y2="10.8" stroke="${s}" stroke-width="1.2" stroke-linecap="round"/>
     <line x1="6.6" y1="13.4" x2="15.8" y2="13.4" stroke="${s}" stroke-width="1.2" stroke-linecap="round"/>
     <line x1="12" y1="16" x2="12" y2="18.6" stroke="${s}" stroke-width="1.4"/>
     <line x1="8" y1="19.4" x2="16" y2="19.4" stroke="${s}" stroke-width="1.6" stroke-linecap="round"/>`,

  // An antenna radiating.
  communication: (s, f) =>
    `<rect x="9" y="14" width="6" height="6" rx="1.2" fill="${f}" stroke="${s}" stroke-width="1.4"/>
     <line x1="12" y1="14" x2="12" y2="8.4" stroke="${s}" stroke-width="1.5" stroke-linecap="round"/>
     <circle cx="12" cy="7" r="1.5" fill="${s}"/>
     ${[
       ["M 7.6 10.2 A 6 6 0 0 1 7.6 4.6", "M 16.4 10.2 A 6 6 0 0 0 16.4 4.6"],
       ["M 5.2 11.6 A 9 9 0 0 1 5.2 3.2", "M 18.8 11.6 A 9 9 0 0 0 18.8 3.2"],
     ]
       .flat()
       .map(
         (d, i) =>
           `<path d="${d}" fill="none" stroke="${s}" stroke-width="1.2" stroke-linecap="round" opacity="${i < 2 ? 0.9 : 0.5}"/>`
       )
       .join("")}`,

  // A battery with a bolt.
  power: (s, f) =>
    `<rect x="2.6" y="7.5" width="16" height="9" rx="1.8" fill="${f}" stroke="${s}" stroke-width="1.4"/>
     <rect x="18.6" y="10" width="2.8" height="4" rx="0.8" fill="${s}"/>
     <path d="M 11.6 8.9 L 8.4 12.4 L 10.9 12.4 L 9.9 15.3 L 13.2 11.6 L 10.7 11.6 Z" fill="${s}"/>`,

  // Stacked memory layers.
  storage: (s, f) =>
    `${[15.2, 11.4, 7.6]
      .map(
        (y, i) =>
          `<rect x="4.2" y="${y}" width="15.6" height="4.4" rx="1.2" fill="${f}" stroke="${s}" stroke-width="1.3" opacity="${1 - i * 0.12}"/>
           <circle cx="7.4" cy="${y + 2.2}" r="0.85" fill="${s}"/>`
      )
      .join("")}`,

  // A clock face.
  clock: (s, f) =>
    `<circle cx="12" cy="12" r="8.2" fill="${f}" stroke="${s}" stroke-width="1.4"/>
     <line x1="12" y1="12" x2="12" y2="6.8" stroke="${s}" stroke-width="1.5" stroke-linecap="round"/>
     <line x1="12" y1="12" x2="15.6" y2="13.6" stroke="${s}" stroke-width="1.5" stroke-linecap="round"/>
     <circle cx="12" cy="12" r="1.1" fill="${s}"/>
     ${[0, 90, 180, 270]
       .map(
         (a) =>
           `<line x1="12" y1="4.6" x2="12" y2="5.9" stroke="${s}" stroke-width="1.2" stroke-linecap="round" transform="rotate(${a} 12 12)"/>`
       )
       .join("")}`,

  // A pressable button.
  input: (s, f) =>
    `<rect x="3.4" y="13.8" width="17.2" height="6.4" rx="1.8" fill="${f}" stroke="${s}" stroke-width="1.4"/>
     <path d="M 7.4 13.8 A 4.6 4.6 0 0 1 16.6 13.8 Z" fill="${f}" stroke="${s}" stroke-width="1.4"/>
     <line x1="12" y1="4.2" x2="12" y2="7.6" stroke="${s}" stroke-width="1.4" stroke-linecap="round"/>
     <path d="M 10.1 6.4 L 12 8.4 L 13.9 6.4" fill="none" stroke="${s}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
};

/**
 * Render a class icon centred at (cx, cy) at `size` px.
 * Deterministic: no randomness, no external assets, pure string output.
 */
export function renderPartIcon(partClass, { cx, cy, size = 52 }) {
  const style = partClassStyle(partClass);
  const draw = ICONS[partClass] ?? ICONS.processing;
  const scale = size / 24;
  const x = cx - size / 2;
  const y = cy - size / 2;

  return (
    `<g transform="translate(${Number(x.toFixed(2))} ${Number(y.toFixed(2))}) scale(${Number(scale.toFixed(4))})">` +
    draw(style.stroke, style.fill) +
    `</g>`
  );
}

export const PART_CLASSES = Object.keys(PART_CLASS_STYLE);
