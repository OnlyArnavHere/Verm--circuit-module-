/**
 * Consume tscircuit's native error elements into our error taxonomy.
 *
 * Phase 2 confirmed tscircuit does NOT hallucinate footprints — when something
 * is wrong it emits structured `*_error` elements into the Circuit JSON, with
 * useful messages. Those map close to 1:1 onto PROJECT_PLAN §4, so we translate
 * rather than re-deriving equivalent checks.
 *
 * IMPORTANT: absence of error elements is NOT proof of validity — see
 * assertions.js. This module handles what tscircuit *does* report; the
 * assertions handle what it silently misses.
 */
import { SEVERITY } from "../models/constants.js";

/** tscircuit element `type` -> our taxonomy code. */
const ERROR_TYPE_MAP = Object.freeze({
  source_invalid_component_property_error: "FOOTPRINT_NOT_FOUND",
  pcb_missing_footprint_error: "FOOTPRINT_NOT_FOUND",
  source_failed_to_create_component_error: "COMPONENT_NOT_FOUND",
  source_trace_not_connected_error: "PIN_NOT_FOUND",
  pcb_port_not_matched_error: "PIN_NOT_FOUND",
  schematic_port_not_matched_error: "PIN_NOT_FOUND",
  pcb_trace_error: "ROUTING_FAILURE",
  pcb_autorouting_error: "ROUTING_FAILURE",
  pcb_placement_error: "BOARD_CONSTRAINT_FAILURE",
  pcb_component_outside_board_error: "BOARD_CONSTRAINT_FAILURE",
  pcb_footprint_overlap_error: "DRC_FAILURE",
  pcb_trace_overlap_error: "DRC_FAILURE",
  drc_error: "DRC_FAILURE",
});

/**
 * `source_invalid_component_property_error` covers any bad prop, not just
 * footprints. Refine using the message so a bad footprint isn't reported as,
 * say, a bad resistance.
 */
function refineInvalidProperty(element) {
  const message = String(element.message ?? "");
  if (/footprint/i.test(message)) return "FOOTPRINT_NOT_FOUND";
  return "UNSUPPORTED_COMPONENT";
}

/** Anything ending in `_error` that we haven't mapped still gets surfaced. */
const FALLBACK_CODE = "UNSUPPORTED_COMPONENT";

/**
 * @param {Array<object>} circuitJson
 * @returns {{errors: object[], warnings: object[], unmappedTypes: string[]}}
 */
export function collectTscircuitIssues(circuitJson) {
  const errors = [];
  const warnings = [];
  const unmappedTypes = new Set();

  for (const element of circuitJson ?? []) {
    const type = String(element?.type ?? "");

    if (type.endsWith("_error")) {
      let code = ERROR_TYPE_MAP[type];
      if (type === "source_invalid_component_property_error") {
        code = refineInvalidProperty(element);
      }
      if (!code) {
        unmappedTypes.add(type);
        code = FALLBACK_CODE;
      }

      errors.push({
        code,
        severity: SEVERITY.ERROR,
        message: String(element.message ?? type),
        target: element.component_name ?? element.source_component_id ?? element.pcb_component_id,
        detail: { tscircuitType: type, raw: element },
      });
    } else if (type.endsWith("_warning")) {
      warnings.push({
        code: FALLBACK_CODE,
        severity: SEVERITY.WARNING,
        message: String(element.message ?? type),
        target: element.component_name ?? element.source_component_id,
        detail: { tscircuitType: type },
      });
    }
  }

  return { errors, warnings, unmappedTypes: [...unmappedTypes] };
}
