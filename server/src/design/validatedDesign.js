/**
 * ValidatedDesign — the deterministic contract between the agent layer and the
 * compiler (PROJECT_PLAN §0).
 *
 *   LLM Agent -> ValidatedDesign -> Deterministic Compiler -> tscircuit -> Artifacts
 *
 * Everything downstream of this object is deterministic. Nothing in here is
 * inferred, guessed, or LLM-authored: each resolved value carries its `source`
 * so an unverified value cannot masquerade as a verified one.
 *
 * Deliberately tscircuit-agnostic — `footprint` is a string and `pads` are
 * numbers/names. Swapping renderers should not require reshaping this schema.
 *
 * See docs/VALIDATED_DESIGN_SCHEMA.md for the full field reference.
 */
import { resolveFootprint } from "./footprintMap.js";

/** Bump when the shape changes incompatibly. Part of the determinism key. */
export const VALIDATED_DESIGN_VERSION = "1.0";

/** How a resolved value was obtained. `unresolved` must never reach the compiler. */
export const RESOLUTION_SOURCE = Object.freeze({
  UPSTREAM: "upstream", // copied verbatim from the Hardware Agent
  CURATED: "curated", // our verified mapping table
  PARTS_ENGINE: "parts_engine", // jlcpcb/easyeda lookup, cached
  MOCK: "mock", // explicitly fabricated placeholder — must be labelled
  UNRESOLVED: "unresolved", // known-missing; carries an error
});

const parsePinRef = (ref) => {
  const [component, pin] = String(ref).split(".");
  return { component, pin };
};

/**
 * Detect nets fully subsumed by a larger net of the same class.
 *
 * The fixtures carry `POWER_1..N` pairwise links whose endpoints are already all
 * present in `POWER_RAIL_3V3`. Keeping them would produce redundant copper and a
 * misleading diagram. Removal is recorded as a modification — never silent
 * (PROJECT_PLAN §5).
 */
function deduplicateNets(nets) {
  const kept = [];
  const modifications = [];

  const memberSet = (net) => new Set((net.connections ?? []).map(String));
  const sorted = [...nets].sort(
    (a, b) => (b.connections?.length ?? 0) - (a.connections?.length ?? 0)
  );

  for (const net of sorted) {
    const members = memberSet(net);
    const superset = kept.find((other) => {
      if (other.net_class !== net.net_class) return false;
      const otherMembers = memberSet(other);
      if (otherMembers.size <= members.size) return false;
      return [...members].every((m) => otherMembers.has(m));
    });

    if (superset) {
      modifications.push({
        target: `nets.${net.name}`,
        field: "connections",
        originalValue: net.connections,
        correctedValue: null,
        reason:
          `Net "${net.name}" is fully contained in "${superset.name}", which already ` +
          `connects all of its endpoints. Kept as a single net to avoid redundant copper.`,
        detectedBy: "NET_SUBSUMED_BY_LARGER_NET",
      });
      continue;
    }
    kept.push(net);
  }

  // Restore the upstream ordering of surviving nets for stable output.
  const order = new Map(nets.map((net, index) => [net.name, index]));
  kept.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));

  return { nets: kept, modifications };
}

/**
 * Build a ValidatedDesign from an upstream Hardware Agent payload.
 *
 * Fails explicitly rather than guessing: unresolved footprints and unresolved
 * pins produce taxonomy errors and mark the design not-compilable.
 *
 * @returns {{design: object, errors: object[], modifications: object[], compilable: boolean}}
 */
export function buildValidatedDesign(upstream) {
  const errors = [];
  const modifications = [];

  // --- components ----------------------------------------------------------
  const components = (upstream.components ?? []).map((component) => {
    const footprintResult = resolveFootprint(component.package);

    if (!footprintResult.ok) {
      errors.push({
        code: footprintResult.code,
        message: footprintResult.message,
        target: component.ref_id,
        detail: {
          package: footprintResult.package,
          candidates: footprintResult.candidates,
        },
      });
    }

    return {
      ref_id: component.ref_id,
      part_number: component.part_number,
      part_class: component.part_class,
      package: component.package,

      footprint: footprintResult.ok
        ? {
            value: footprintResult.footprint,
            expectedPadCount: footprintResult.expectedPadCount,
            source: RESOLUTION_SOURCE.CURATED,
            evidence: footprintResult.evidence,
          }
        : { value: null, expectedPadCount: null, source: RESOLUTION_SOURCE.UNRESOLVED, evidence: null },

      // Pin maps require a verified pinout for the part. We have none, and
      // PROJECT_PLAN §4 forbids inventing one — so this stays unresolved and
      // the design is not compilable until a real source supplies it.
      pins: { source: RESOLUTION_SOURCE.UNRESOLVED, map: {} },

      symbol: { value: null, source: RESOLUTION_SOURCE.UNRESOLVED },
      model3d: { value: null, source: RESOLUTION_SOURCE.UNRESOLVED },
    };
  });

  const knownRefs = new Set(components.map((c) => c.ref_id));

  // --- nets ----------------------------------------------------------------
  const dedup = deduplicateNets(upstream.nets ?? []);
  modifications.push(...dedup.modifications);

  const nets = dedup.nets.map((net) => ({
    name: net.name,
    net_class: net.net_class,
    members: (net.connections ?? []).map((connection) => {
      const { component, pin } = parsePinRef(connection);

      if (!knownRefs.has(component)) {
        errors.push({
          code: "COMPONENT_NOT_FOUND",
          message: `Net "${net.name}" references unknown component "${component}".`,
          target: connection,
          detail: {},
        });
      }

      return {
        ref_id: component,
        logicalPin: pin,
        // Logical -> physical pad resolution needs a verified pinout. Left null
        // deliberately; see `pins.source === "unresolved"` above.
        physicalPin: null,
        pad: null,
        source: RESOLUTION_SOURCE.UNRESOLVED,
      };
    }),
  }));

  // Every component with an unresolved pin map yields one PIN_NOT_FOUND, rather
  // than one per net member, to keep the error list readable.
  for (const component of components) {
    if (component.pins.source === RESOLUTION_SOURCE.UNRESOLVED) {
      errors.push({
        code: "PIN_NOT_FOUND",
        message:
          `No verified pinout for "${component.part_number}" (${component.ref_id}); ` +
          `logical pins cannot be mapped to physical pads. Pinout must come from a ` +
          `verified source — it will not be inferred.`,
        target: component.ref_id,
        detail: { part_number: component.part_number },
      });
    }
  }

  // --- constraints ---------------------------------------------------------
  const outline = upstream.constraints?.board_outline ?? {};
  const constraints = {
    layer_count: upstream.constraints?.layer_count ?? null,
    board_outline: {
      shape: outline.shape ?? "rectangle",
      width_mm: outline.width_mm ?? null,
      height_mm: outline.height_mm ?? null,
    },
  };

  if (!constraints.board_outline.width_mm || !constraints.board_outline.height_mm) {
    errors.push({
      code: "BOARD_CONSTRAINT_FAILURE",
      message: "Board outline is missing numeric width_mm/height_mm.",
      target: "constraints.board_outline",
      detail: constraints.board_outline,
    });
  }

  const design = {
    validated_design_version: VALIDATED_DESIGN_VERSION,
    design_name: upstream.design_name,
    upstream_schema_version: upstream.schema_version,
    components,
    nets,
    constraints,
  };

  return {
    design,
    errors,
    modifications,
    // A design is compilable only when nothing critical is unresolved. Note this
    // is computed from the error list, never assumed from a lack of complaints.
    compilable: errors.length === 0,
  };
}
