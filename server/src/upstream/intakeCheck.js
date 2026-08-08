/**
 * INTAKE-LEVEL structural check only.
 *
 * This answers one question: "is this payload shaped like a Hardware Agent
 * document at all?" — enough to create a job record against.
 *
 * It is NOT the design validator. Electrical correctness, net de-duplication,
 * protocol checks (the SCK<->MOSI bug), pin resolution, and everything else in
 * PROJECT_PLAN.md sections 1 and 4 belong to the deterministic validation layer
 * built in Phases 3-5. Do not grow this file into that validator; a malformed
 * *structure* is an intake failure, a wrong *design* is a validation failure,
 * and they must stay distinguishable.
 */

const SUPPORTED_SCHEMA_VERSIONS = ["1.0"];

const PART_CLASSES = [
  "processing",
  "sensor",
  "output",
  "communication",
  "power",
  "storage",
  "clock",
  "input",
];

const NET_CLASSES = ["ground", "power", "signal"];

/** @returns {{ok: true, schemaVersion: string, designName: string, warnings: string[]} | {ok: false, code: string, message: string, issues: string[]}} */
export function checkIntakeShape(payload) {
  const issues = [];
  const warnings = [];

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      code: "MALFORMED_UPLOAD",
      message: "Uploaded JSON must be an object.",
      issues: ["root is not a JSON object"],
    };
  }

  const { schema_version: schemaVersion, design_name: designName } = payload;

  if (typeof schemaVersion !== "string") {
    issues.push("schema_version is missing or not a string");
  } else if (!SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion)) {
    return {
      ok: false,
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `Unsupported schema_version "${schemaVersion}". Supported: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}.`,
      issues: [],
    };
  }

  if (typeof designName !== "string" || designName.trim() === "") {
    issues.push("design_name is missing or empty");
  }

  if (!Array.isArray(payload.components)) {
    issues.push("components is missing or not an array");
  } else if (payload.components.length === 0) {
    issues.push("components is empty");
  } else {
    const seenRefIds = new Set();
    payload.components.forEach((component, index) => {
      const at = `components[${index}]`;
      if (component === null || typeof component !== "object") {
        issues.push(`${at} is not an object`);
        return;
      }
      if (typeof component.ref_id !== "string" || !component.ref_id) {
        issues.push(`${at}.ref_id is missing`);
      } else if (seenRefIds.has(component.ref_id)) {
        // Duplicate ref_ids make every "U1.PIN" reference ambiguous, so this is
        // structural, not electrical.
        issues.push(`${at}.ref_id "${component.ref_id}" is duplicated`);
      } else {
        seenRefIds.add(component.ref_id);
      }
      if (typeof component.part_number !== "string" || !component.part_number) {
        issues.push(`${at}.part_number is missing`);
      }
      if (!PART_CLASSES.includes(component.part_class)) {
        warnings.push(
          `${at}.part_class "${component.part_class}" is outside the known set`
        );
      }
      if (typeof component.package !== "string" || !component.package) {
        warnings.push(`${at}.package is missing`);
      }
    });
  }

  if (!Array.isArray(payload.nets)) {
    issues.push("nets is missing or not an array");
  } else {
    payload.nets.forEach((net, index) => {
      const at = `nets[${index}]`;
      if (net === null || typeof net !== "object") {
        issues.push(`${at} is not an object`);
        return;
      }
      if (typeof net.name !== "string" || !net.name) {
        issues.push(`${at}.name is missing`);
      }
      if (!Array.isArray(net.connections)) {
        issues.push(`${at}.connections is missing or not an array`);
      } else {
        net.connections.forEach((connection, connectionIndex) => {
          if (typeof connection !== "string" || !/^[^.]+\.[^.]+$/.test(connection)) {
            issues.push(
              `${at}.connections[${connectionIndex}] must look like "REF.PIN", got ${JSON.stringify(connection)}`
            );
          }
        });
      }
      if (!NET_CLASSES.includes(net.net_class)) {
        warnings.push(`${at}.net_class "${net.net_class}" is outside the known set`);
      }
    });
  }

  const outline = payload.constraints?.board_outline;
  if (!payload.constraints || typeof payload.constraints !== "object") {
    issues.push("constraints is missing");
  } else if (!outline || typeof outline !== "object") {
    issues.push("constraints.board_outline is missing");
  } else if (
    typeof outline.width_mm !== "number" ||
    typeof outline.height_mm !== "number"
  ) {
    issues.push("constraints.board_outline needs numeric width_mm and height_mm");
  }

  if (issues.length > 0) {
    return {
      ok: false,
      code: "MALFORMED_UPLOAD",
      message: `Payload is not a well-formed Hardware Agent document (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
      issues,
    };
  }

  return { ok: true, schemaVersion, designName, warnings };
}
