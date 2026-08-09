/**
 * Conversational modification — bounded instruction, deterministic transform
 * (Phase 8).
 *
 * Scope is ONE modification type: component repositioning. Anything else is
 * rejected as unsupported rather than reinterpreted, for the same reason Group C
 * was deferred: swaps and net changes cascade through footprint resolution and
 * electrical validation.
 *
 * ── Where geometry comes from ───────────────────────────────────────────────
 * For `edge` and `relative_to`, the model names an edge/direction and a distance;
 * THIS module resolves millimetres from the board outline and real footprint
 * size. The model expresses intent, the deterministic layer produces geometry —
 * PROJECT_PLAN §1's rule, applied to modifications.
 *
 * `absolute` exists only to carry a coordinate the USER stated ("put it at
 * x=20,y=15"). It is not a licence for the model to invent one from a vague
 * request — a vague request must route through `edge`/`relative_to`. Its output
 * gets exactly the same validation as every other mode; a human-supplied number
 * buys no shortcut.
 */
import { boardBounds, estimateComponentSize, PLACEMENT_SOURCE } from "./placement.js";

/** Real size when we have one from a compiled board, estimate otherwise. */
const sizeFor = (refId, sizes) => {
  const real = sizes?.[refId];
  if (real?.width_mm && real?.height_mm) return real;
  return estimateComponentSize(sizes?.[refId]?.padCount);
};

export const INSTRUCTION_VERSION = "1.0";

export const INSTRUCTION_TYPE = Object.freeze({
  REPOSITION: "REPOSITION_COMPONENT",
  UNSUPPORTED: "UNSUPPORTED",
});

export const PLACEMENT_MODE = Object.freeze({
  EDGE: "edge",
  RELATIVE_TO: "relative_to",
  DELTA: "delta",
  ABSOLUTE: "absolute",
});

const EDGES = new Set(["left", "right", "top", "bottom"]);
const DIRECTIONS = new Set(["left", "right", "above", "below"]);
const finite = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * Structural validation of the instruction itself, before it touches a design.
 * Shape errors are `UNSUPPORTED_COMPONENT`: the request was not expressible in
 * the bounded schema.
 */
export function validateInstructionShape(instruction) {
  const errors = [];
  const push = (message) =>
    errors.push({ code: "UNSUPPORTED_COMPONENT", message, target: "instruction", detail: {} });

  if (!instruction || typeof instruction !== "object") {
    push("instruction is not an object");
    return { ok: false, errors };
  }
  if (instruction.type === INSTRUCTION_TYPE.UNSUPPORTED) {
    return {
      ok: false,
      unsupported: true,
      errors: [
        {
          code: "UNSUPPORTED_COMPONENT",
          message:
            `Request is not a component repositioning and is unsupported in Phase 8: ` +
            `${instruction.reason ?? "no reason given"}`,
          target: "instruction",
          detail: { requestedChangeClass: instruction.requested_change_class ?? "unclear" },
        },
      ],
    };
  }
  if (instruction.type !== INSTRUCTION_TYPE.REPOSITION) {
    push(`unknown instruction type "${instruction.type}"`);
    return { ok: false, errors };
  }
  if (!instruction.target?.ref_id) push("target.ref_id is missing");

  const placement = instruction.placement;
  if (!placement?.mode) {
    push("placement.mode is missing");
    return { ok: false, errors };
  }

  switch (placement.mode) {
    case PLACEMENT_MODE.EDGE:
      if (!EDGES.has(placement.edge)) push(`placement.edge must be one of ${[...EDGES].join(", ")}`);
      if (!finite(placement.margin_mm) || placement.margin_mm < 0) push("placement.margin_mm must be a non-negative number");
      break;
    case PLACEMENT_MODE.RELATIVE_TO:
      if (!placement.ref_id) push("placement.ref_id is missing");
      if (!DIRECTIONS.has(placement.direction)) push(`placement.direction must be one of ${[...DIRECTIONS].join(", ")}`);
      if (!finite(placement.distance_mm) || placement.distance_mm < 0) push("placement.distance_mm must be a non-negative number");
      break;
    case PLACEMENT_MODE.DELTA:
      if (!finite(placement.dx_mm) || !finite(placement.dy_mm)) push("placement.dx_mm and dy_mm must be numbers");
      break;
    case PLACEMENT_MODE.ABSOLUTE:
      if (!finite(placement.x_mm) || !finite(placement.y_mm)) push("placement.x_mm and y_mm must be numbers");
      break;
    default:
      push(`unknown placement.mode "${placement.mode}"`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Resolve a validated instruction to concrete millimetres.
 * This is the deterministic half — no model output is used as geometry here
 * except the raw numbers of `delta`/`absolute`, which are still validated after.
 */
export function resolvePlacement(instruction, design, sizes = {}) {
  const refId = instruction.target.ref_id;
  const current = design.placement?.components?.[refId];
  if (!current) {
    return {
      ok: false,
      errors: [
        {
          code: "COMPONENT_NOT_FOUND",
          message: `Component "${refId}" is not placed in this design.`,
          target: refId,
          detail: {},
        },
      ],
    };
  }

  const bounds = boardBounds(design.constraints?.board_outline);
  const size = sizeFor(refId, sizes);
  const placement = instruction.placement;
  let x = current.x_mm;
  let y = current.y_mm;

  switch (placement.mode) {
    case PLACEMENT_MODE.EDGE: {
      // The model said "left edge, 5mm". The millimetres come from the board
      // outline and the component's own half-width — not from the model.
      const halfW = size.width_mm / 2;
      const halfH = size.height_mm / 2;
      if (placement.edge === "left") x = bounds.minX + placement.margin_mm + halfW;
      if (placement.edge === "right") x = bounds.maxX - placement.margin_mm - halfW;
      if (placement.edge === "bottom") y = bounds.minY + placement.margin_mm + halfH;
      if (placement.edge === "top") y = bounds.maxY - placement.margin_mm - halfH;
      break;
    }
    case PLACEMENT_MODE.RELATIVE_TO: {
      const anchor = design.placement?.components?.[placement.ref_id];
      if (!anchor) {
        return {
          ok: false,
          errors: [
            {
              code: "COMPONENT_NOT_FOUND",
              message: `Reference component "${placement.ref_id}" is not placed in this design.`,
              target: placement.ref_id,
              detail: {},
            },
          ],
        };
      }
      const offset = placement.distance_mm;
      x = anchor.x_mm + (placement.direction === "left" ? -offset : placement.direction === "right" ? offset : 0);
      y = anchor.y_mm + (placement.direction === "below" ? -offset : placement.direction === "above" ? offset : 0);
      break;
    }
    case PLACEMENT_MODE.DELTA:
      x = current.x_mm + placement.dx_mm;
      y = current.y_mm + placement.dy_mm;
      break;
    case PLACEMENT_MODE.ABSOLUTE:
      x = placement.x_mm;
      y = placement.y_mm;
      break;
    default:
      break;
  }

  return {
    ok: true,
    from: { x_mm: current.x_mm, y_mm: current.y_mm },
    to: { x_mm: Number(x.toFixed(3)), y_mm: Number(y.toFixed(3)) },
    componentSize: size,
  };
}

/**
 * Deterministic pre-checks on the resolved position, before spending a compile.
 * Cheap rejects only — the authoritative check is the real DRC re-run.
 */
export function validateResolvedPlacement(refId, resolved, design, sizes = {}) {
  const errors = [];
  const bounds = boardBounds(design.constraints?.board_outline);
  const { to, componentSize } = resolved;
  const halfW = componentSize.width_mm / 2;
  const halfH = componentSize.height_mm / 2;

  if (
    to.x_mm - halfW < bounds.minX ||
    to.x_mm + halfW > bounds.maxX ||
    to.y_mm - halfH < bounds.minY ||
    to.y_mm + halfH > bounds.maxY
  ) {
    errors.push({
      code: "BOARD_CONSTRAINT_FAILURE",
      message:
        `Moving "${refId}" to (${to.x_mm}, ${to.y_mm}) would put part of its ` +
        `${componentSize.width_mm.toFixed(1)}mm footprint outside the ` +
        `${bounds.width}x${bounds.height}mm board outline.`,
      target: refId,
      detail: { to, bounds },
    });
  }

  // Trivial-overlap pre-check against every other placed component.
  for (const [otherRef, seat] of Object.entries(design.placement?.components ?? {})) {
    if (otherRef === refId) continue;
    const otherSize = sizeFor(otherRef, sizes);
    const dx = Math.abs(to.x_mm - seat.x_mm);
    const dy = Math.abs(to.y_mm - seat.y_mm);
    if (dx < halfW + otherSize.width_mm / 2 && dy < halfH + otherSize.height_mm / 2) {
      errors.push({
        code: "DRC_FAILURE",
        message:
          `Moving "${refId}" to (${to.x_mm}, ${to.y_mm}) would overlap "${otherRef}" at ` +
          `(${seat.x_mm}, ${seat.y_mm}). Rejected before compiling.`,
        target: refId,
        detail: { collidesWith: otherRef, to },
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Produce the NEW ValidatedDesign. Pure: the input design is not mutated, so a
 * rejected modification cannot corrupt the version it was derived from.
 */
export function applyPlacement(design, refId, to) {
  const next = structuredClone(design);
  next.placement.components[refId] = {
    ...next.placement.components[refId],
    x_mm: to.x_mm,
    y_mm: to.y_mm,
    // Marked so a later re-layout cannot silently discard a requested position.
    source: PLACEMENT_SOURCE.MODIFIED,
  };
  next.placement.source = PLACEMENT_SOURCE.MODIFIED;
  return next;
}

/**
 * Full deterministic pipeline for one instruction, up to (not including) compile.
 * @returns {{ok: boolean, design?: object, resolved?: object, errors: object[]}}
 */
export function applyModification(instruction, design, sizes = {}) {
  const shape = validateInstructionShape(instruction);
  if (!shape.ok) return { ok: false, errors: shape.errors, unsupported: shape.unsupported ?? false };

  const refId = instruction.target.ref_id;
  const resolved = resolvePlacement(instruction, design, sizes);
  if (!resolved.ok) return { ok: false, errors: resolved.errors };

  const check = validateResolvedPlacement(refId, resolved, design, sizes);
  if (!check.ok) return { ok: false, errors: check.errors, resolved };

  return { ok: true, design: applyPlacement(design, refId, resolved.to), resolved, errors: [] };
}
