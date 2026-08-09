/**
 * Component placement as explicit `ValidatedDesign` state (Phase 8).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Placement used to be computed inside `generateTscircuitSource` at compile
 * time, so it was never a value anything could read, diff, or modify. A
 * repositioning transform would have had to reach into the compiler.
 *
 * Two consequences of promoting it here:
 *  - a modification has somewhere to write, and versions become diffable;
 *  - "where should this part sit" moves out of the deterministic compiler,
 *    where it never belonged — design planning is an Agent-layer concern
 *    (ARCHITECTURE.md §"Layer ownership").
 *
 * The grid below is byte-identical to the compiler's previous logic, so v1
 * boards are unchanged by the move.
 */

export const PLACEMENT_SOURCE = Object.freeze({
  AUTO_GRID: "auto_grid", // produced by the default generator
  MODIFIED: "modified", // set by an applied modification — never silently re-laid-out
});

/**
 * Default placement generator: the same deterministic grid the compiler used.
 *
 * Sorted by ref_id and derived only from board size and component count, so it
 * remains reproducible.
 */
export function generateGridPlacement(components, boardOutline) {
  const width = boardOutline?.width_mm ?? 100;
  const height = boardOutline?.height_mm ?? 60;
  const sorted = [...(components ?? [])].sort((a, b) => a.ref_id.localeCompare(b.ref_id));

  const perRow = Math.ceil(Math.sqrt(sorted.length)) || 1;
  const stepX = width / (perRow + 1);
  const stepY = height / (Math.ceil(sorted.length / perRow) + 1);

  const placed = {};
  sorted.forEach((component, index) => {
    const col = index % perRow;
    const row = Math.floor(index / perRow);
    placed[component.ref_id] = {
      x_mm: Number((-width / 2 + stepX * (col + 1)).toFixed(3)),
      y_mm: Number((height / 2 - stepY * (row + 1)).toFixed(3)),
      rotation_deg: 0,
      // Schematic coordinates travel with placement so the compiler consumes a
      // complete description rather than deriving half of it.
      sch_x: Number(((col - (perRow - 1) / 2) * 5).toFixed(3)),
      sch_y: Number((-(row * 5)).toFixed(3)),
      source: PLACEMENT_SOURCE.AUTO_GRID,
    };
  });

  return { source: PLACEMENT_SOURCE.AUTO_GRID, components: placed };
}

/** Board-outline bounds in tscircuit's centre-origin coordinates. */
export function boardBounds(boardOutline) {
  const width = boardOutline?.width_mm ?? 0;
  const height = boardOutline?.height_mm ?? 0;
  return {
    minX: -width / 2,
    maxX: width / 2,
    minY: -height / 2,
    maxY: height / 2,
    width,
    height,
  };
}

/**
 * REAL footprint extents, read from a compiled board.
 *
 * `pcb_component` elements carry actual width/height in mm. Using these instead
 * of an estimate matters: a first run guessed `RF-BM-2340A2I` at 3mm when it is
 * really 15.2mm wide, so an "edge, 5mm margin" request placed it 1.4mm off the
 * board — DRC caught it, but the request was legitimate and should have worked.
 */
export function componentSizesFrom(circuitJson) {
  const sourceNames = new Map();
  for (const element of circuitJson ?? []) {
    if (element?.type === "source_component") sourceNames.set(element.source_component_id, element.name);
  }
  const sizes = {};
  for (const element of circuitJson ?? []) {
    if (element?.type !== "pcb_component") continue;
    const ref = sourceNames.get(element.source_component_id);
    if (!ref) continue;
    sizes[ref] = {
      width_mm: Number(element.width ?? 0) || undefined,
      height_mm: Number(element.height ?? 0) || undefined,
    };
  }
  return sizes;
}

/**
 * Fallback footprint extent when no compiled board is available.
 *
 * Deliberately approximate and biased large: it is a cheap guard before spending
 * a compile, and the authoritative check is the real DRC re-run. Overestimating
 * rejects marginal placements rather than passing them.
 */
export function estimateComponentSize(padCount) {
  const pads = Math.max(1, padCount ?? 8);
  // Roughly a square whose area grows with pad count; clamped to sane bounds.
  const side = Math.min(20, Math.max(3, Math.sqrt(pads) * 1.6));
  return { width_mm: side, height_mm: side };
}
