/**
 * Independent post-compile assertions.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Phase 2, risk R1: `footprint="DFN-8-EP(2x3)"` compiles with ZERO errors, ZERO
 * warnings, and ZERO PADS, while still emitting silkscreen and courtyard
 * geometry. It renders convincingly in both SVG and 3D. The board cannot be
 * manufactured — there is no copper to solder to.
 *
 * Therefore: **"no error elements" is not a green light.** These assertions run
 * against the compiled Circuit JSON regardless of what tscircuit reported, and
 * they are the reason a silent zero-pad footprint cannot reach an artifact.
 *
 * Do not delete these on the grounds that tscircuit already validates. It does
 * not. (DECISIONS.md D-009)
 */
import { SEVERITY } from "../models/constants.js";

const PAD_TYPES = new Set(["pcb_smtpad", "pcb_plated_hole", "pcb_hole"]);

/**
 * Count pads per pcb_component_id.
 * @param {Array<object>} circuitJson
 */
function padCountsByComponent(circuitJson) {
  const counts = new Map();
  for (const element of circuitJson ?? []) {
    if (!PAD_TYPES.has(element?.type)) continue;
    const id = element.pcb_component_id;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Map pcb_component_id -> a human-facing ref (U1) via source components. */
function componentNames(circuitJson) {
  const sourceNames = new Map();
  for (const element of circuitJson ?? []) {
    if (element?.type === "source_component") {
      sourceNames.set(element.source_component_id, element.name);
    }
  }
  const byPcbId = new Map();
  for (const element of circuitJson ?? []) {
    if (element?.type === "pcb_component") {
      byPcbId.set(
        element.pcb_component_id,
        sourceNames.get(element.source_component_id) ?? element.pcb_component_id
      );
    }
  }
  return byPcbId;
}

/**
 * Assert every compiled component has pads, and that the count matches what the
 * resolved footprint promised.
 *
 * @param {Array<object>} circuitJson compiled Circuit JSON
 * @param {Map<string, number>|object} expectedByRef ref_id -> expectedPadCount
 *        (from footprintMap.resolveFootprint). Refs absent from this map are
 *        still checked for the zero-pad case.
 * @returns {{ok: boolean, errors: object[]}}
 */
export function assertPadIntegrity(circuitJson, expectedByRef = new Map()) {
  const expected =
    expectedByRef instanceof Map ? expectedByRef : new Map(Object.entries(expectedByRef ?? {}));

  const counts = padCountsByComponent(circuitJson);
  const names = componentNames(circuitJson);
  const errors = [];

  const pcbComponents = (circuitJson ?? []).filter((el) => el?.type === "pcb_component");

  if (pcbComponents.length === 0) {
    errors.push({
      code: "FOOTPRINT_NOT_FOUND",
      severity: SEVERITY.ERROR,
      message:
        "Compiled Circuit JSON contains no pcb_component elements — nothing was placed on the board.",
      target: null,
      detail: {},
    });
  }

  for (const component of pcbComponents) {
    const id = component.pcb_component_id;
    const ref = names.get(id) ?? id;
    const actual = counts.get(id) ?? 0;

    if (actual === 0) {
      errors.push({
        code: "FOOTPRINT_NOT_FOUND",
        severity: SEVERITY.ERROR,
        message:
          `Component "${ref}" compiled with ZERO pads. tscircuit reported no error, ` +
          `but a component with no copper cannot be manufactured. ` +
          `This is the silent zero-pad failure mode (Phase 2 risk R1).`,
        target: ref,
        detail: { pcb_component_id: id, actualPadCount: 0 },
      });
      continue;
    }

    const want = expected.get(ref);
    if (typeof want === "number" && want !== actual) {
      errors.push({
        code: "FOOTPRINT_NOT_FOUND",
        severity: SEVERITY.ERROR,
        message:
          `Component "${ref}" compiled with ${actual} pads but the resolved footprint ` +
          `promised ${want}. The footprint does not match the resolved part.`,
        target: ref,
        detail: { pcb_component_id: id, actualPadCount: actual, expectedPadCount: want },
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Assert every net in the ValidatedDesign became real copper.
 * A net silently dropped during routing is as dangerous as a missing pad.
 */
export function assertNetsRealized(circuitJson, validatedDesign) {
  const errors = [];
  const traceCount = (circuitJson ?? []).filter((el) => el?.type === "pcb_trace").length;
  const expectedNets = (validatedDesign?.nets ?? []).filter(
    (net) => net.net_class !== "ground" && net.net_class !== "power"
  ).length;

  if (expectedNets > 0 && traceCount === 0) {
    errors.push({
      code: "ROUTING_FAILURE",
      severity: SEVERITY.ERROR,
      message:
        `ValidatedDesign declares ${expectedNets} signal net(s) but the compiled board ` +
        `contains no pcb_trace elements — nothing was routed.`,
      target: null,
      detail: { expectedNets, traceCount },
    });
  }

  return { ok: errors.length === 0, errors };
}
