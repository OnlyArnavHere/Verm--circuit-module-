/**
 * Shared vocabulary for job records. Kept in one place so the Phase 3/4/5 layers
 * and the frontend agree on exact string values.
 */

/** Job lifecycle. `received` is the only state Phase 1 can reach. */
export const JOB_STATUS = Object.freeze({
  RECEIVED: "received",
  VALIDATING: "validating",
  RESOLVING: "resolving",
  COMPILING: "compiling",
  GENERATING: "generating",
  UPLOADING: "uploading",
  COMPLETED: "completed",
  FAILED: "failed",
});

export const JOB_STATUS_VALUES = Object.values(JOB_STATUS);

/**
 * The four required outputs (PROJECT_PLAN.md section 0). Every one of these must
 * eventually be a real file in object storage, never a live-render-only view.
 */
export const OUTPUT_KINDS = Object.freeze({
  CIRCUIT: "circuit",
  SCHEMATIC: "schematic",
  PCB: "pcb",
  MODEL_3D: "model3d",
});

export const OUTPUT_KIND_VALUES = Object.values(OUTPUT_KINDS);

/**
 * Error taxonomy from PROJECT_PLAN.md section 4. The system fails explicitly with
 * one of these codes — it never guesses and never silently degrades.
 */
export const ERROR_CODES = Object.freeze([
  "COMPONENT_NOT_FOUND",
  "PIN_NOT_FOUND",
  "FOOTPRINT_NOT_FOUND",
  "MODEL_3D_NOT_FOUND",
  "INVALID_NET",
  "ELECTRICAL_CONFLICT",
  "UNSUPPORTED_COMPONENT",
  "ROUTING_FAILURE",
  "DRC_FAILURE",
  "BOARD_CONSTRAINT_FAILURE",
  // Intake-level failures, outside the design taxonomy proper.
  "MALFORMED_UPLOAD",
  "UNSUPPORTED_SCHEMA_VERSION",
]);

export const SEVERITY = Object.freeze({
  ERROR: "error",
  WARNING: "warning",
});
