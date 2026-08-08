/**
 * Design Rule Checking via `@tscircuit/checks`.
 *
 * Phase 2 confirmed the suite exists (placement, netlist, pin-specification and
 * routing checks); Phase 5.5 wires it in so `DRC_FAILURE` is a live path in the
 * taxonomy rather than a code that can never fire.
 *
 * Severity mapping matters: tscircuit emits both `*_error` and `*_warning`
 * elements from these checks. Only errors become `DRC_FAILURE`; warnings are
 * surfaced as warnings so a board is not failed for advisory findings such as
 * "no power pin declared".
 */
import { SEVERITY } from "../models/constants.js";

/** Checks whose findings are placement/board-constraint rather than DRC proper. */
const BOARD_CONSTRAINT_TYPES = new Set([
  "pcb_component_outside_board_error",
  "pcb_components_out_of_board_error",
  "pcb_trace_out_of_board_error",
  "pcb_traces_out_of_board_error",
]);

/**
 * Run the full DRC suite against compiled Circuit JSON.
 *
 * @param {Array<object>} circuitJson
 * @returns {Promise<{errors: object[], warnings: object[], ran: boolean, total: number, byType: object}>}
 */
export async function runDrc(circuitJson) {
  let findings;
  try {
    const checks = await import("@tscircuit/checks");
    // NOTE: runAllChecks is async — awaiting it is not optional. Calling it
    // without await yields a Promise that looks like an empty result object and
    // silently reports "no DRC findings".
    findings = await checks.runAllChecks(circuitJson ?? []);
  } catch (error) {
    return {
      ran: false,
      errors: [],
      warnings: [],
      total: 0,
      byType: {},
      message: `DRC suite unavailable: ${error.message}`,
    };
  }

  const errors = [];
  const warnings = [];
  const byType = {};

  for (const finding of findings ?? []) {
    const type = String(finding.type ?? "unknown");
    byType[type] = (byType[type] ?? 0) + 1;

    const entry = {
      code: BOARD_CONSTRAINT_TYPES.has(type) ? "BOARD_CONSTRAINT_FAILURE" : "DRC_FAILURE",
      message: String(finding.message ?? type),
      target:
        finding.component_display_name ??
        finding.pcb_component_id ??
        finding.source_component_id ??
        null,
      detail: { drcType: type },
    };

    if (type.endsWith("_warning")) {
      warnings.push({ ...entry, severity: SEVERITY.WARNING });
    } else {
      errors.push({ ...entry, severity: SEVERITY.ERROR });
    }
  }

  return { ran: true, errors, warnings, total: (findings ?? []).length, byType };
}
