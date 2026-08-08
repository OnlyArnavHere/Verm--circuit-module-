/**
 * Per-field component resolution: real first, mock only as a per-field fallback.
 *
 * PROJECT_PLAN Phase 5 (revised): a component is rarely all-real or all-mock.
 * "Verified footprint but unknown pinout" is a genuinely different state from
 * "nothing resolved", so provenance is tracked **per field** — never rolled up
 * into one binary flag that hides which fields actually succeeded.
 *
 * Fields tracked independently: footprint, pads, model_3d, symbol, pins.
 */
import { resolveFootprint } from "./footprintMap.js";
import { resolvePart } from "./partsEngine.js";
import { extractPinout, matchLogicalPin } from "./pinout.js";

/**
 * Provenance values, most trusted first. `source` records *how* a value was
 * obtained; `real` is the derived answer to "is this verified part data?".
 *
 * `generated` is deliberately distinct from `mock`: a generic IC box symbol with
 * the correct pin count is deterministically derived, not fabricated — but it is
 * still not the part's real schematic symbol, so it is not `real` either.
 */
export const SOURCE = Object.freeze({
  CURATED: "curated", // human-verified table, carries evidence
  PARTS_ENGINE: "parts_engine", // LCSC/JLCPCB catalogue, package-matched, cached
  GENERATED: "generated", // deterministically derived, not part-specific
  MOCK: "mock", // fabricated placeholder — must carry a reason
  UNRESOLVED: "unresolved", // nothing available; carries an error
});

const REAL_SOURCES = new Set([SOURCE.CURATED, SOURCE.PARTS_ENGINE]);
export const isReal = (source) => REAL_SOURCES.has(source);

const field = (source, value, extra = {}) => ({
  value,
  source,
  real: isReal(source),
  ...extra,
});

/**
 * Resolve one component, field by field.
 *
 * @param {object} component upstream component
 * @param {{allowNetwork?: boolean}} options
 */
export async function resolveComponent(component, options = {}) {
  const errors = [];

  // --- footprint + pads ----------------------------------------------------
  // 1. curated table (highest trust — human-verified with evidence)
  let footprint;
  let pads;

  const curated = resolveFootprint(component.package);
  if (curated.ok) {
    footprint = field(SOURCE.CURATED, curated.footprint, {
      evidence: curated.evidence,
    });
    pads = field(SOURCE.CURATED, null, { expectedCount: curated.expectedPadCount });
  } else {
    // 2. parts engine (cached; accepted only on an exact package match)
    const part = await resolvePart(component, options);

    if (part.ok) {
      footprint = field(SOURCE.PARTS_ENGINE, part.footprint, {
        lcsc: part.lcsc,
        matchedPackage: part.package,
        matchedOn: part.matchedOn,
        cached: part.cached,
      });
      // Pad count comes from the catalogue footprint itself; it is verified
      // after compile by assertPadIntegrity rather than predicted here.
      pads = field(SOURCE.PARTS_ENGINE, null, { expectedCount: null, lcsc: part.lcsc });
    } else {
      // 3. mock — explicit, with the reason resolution failed
      const reason =
        `${curated.message} Parts engine: ${part.message}`;
      footprint = field(SOURCE.MOCK, null, { reason });
      pads = field(SOURCE.MOCK, null, { expectedCount: null, reason });
      errors.push({
        code: "FOOTPRINT_NOT_FOUND",
        message:
          `No verified footprint for "${component.part_number}" (${component.ref_id}); ` +
          `falling back to a labelled mock. ${reason}`,
        target: component.ref_id,
        detail: {
          package: component.package,
          curatedCandidates: curated.candidates ?? [],
          partsEngineDetail: part.detail ?? {},
        },
      });
    }
  }

  // --- 3D model ------------------------------------------------------------
  // The JLCPCB catalogue attaches a 3D model to most parts; whether one actually
  // materialised is confirmed post-compile from cad_component elements.
  const model3d = isReal(footprint.source)
    ? field(footprint.source, null, { pendingCompileConfirmation: true })
    : field(SOURCE.MOCK, null, {
        reason: "no resolved part, so no catalogue 3D model is available",
      });

  if (!isReal(model3d.source)) {
    errors.push({
      code: "MODEL_3D_NOT_FOUND",
      severity: "warning",
      message:
        `No verified 3D model for "${component.part_number}" (${component.ref_id}); ` +
        `the 3D output will contain a placeholder body for this component.`,
      target: component.ref_id,
      detail: {},
    });
  }

  // --- schematic symbol ----------------------------------------------------
  // tscircuit draws chips as a labelled box sized from the pin count. That is
  // the conventional depiction of an IC and is deterministic, but it is not the
  // part's own symbol — so `generated`, never `real`.
  const symbol = field(SOURCE.GENERATED, "chip_box", {
    reason:
      "tscircuit renders ICs as a labelled box from pin count; no part-specific " +
      "schematic symbol exists for this MPN in the available libraries",
  });

  // --- pins ----------------------------------------------------------------
  // Catalogue footprints carry the part's REAL pin names as port hints, so a
  // logical pin (U3.SCL) can often be matched to a real pad by name instead of
  // being assigned positionally. Resolved per pin, not per component: some pins
  // match for real while others on the same part do not.
  const logicalPins = [...(options.logicalPinsByRef?.[component.ref_id] ?? [])].sort();
  const pinMap = {};
  const pinDetail = {};
  let realPins = 0;

  if (isReal(footprint.source) && footprint.value && logicalPins.length > 0) {
    const pinout = await extractPinout(footprint.value, options);

    for (const logical of logicalPins) {
      const match = pinout.ok ? matchLogicalPin(logical, pinout) : { ok: false };
      if (match.ok) {
        pinMap[logical] = match.pad;
        pinDetail[logical] = {
          pad: match.pad,
          source: SOURCE.PARTS_ENGINE,
          real: true,
          via: match.via,
          ...(match.reason ? { reason: match.reason } : {}),
        };
        realPins += 1;
      } else {
        pinDetail[logical] = {
          pad: null,
          source: SOURCE.MOCK,
          real: false,
          reason:
            `part exposes no pin named "${logical}"` +
            (pinout.ok ? ` (has: ${(match.availablePins ?? []).slice(0, 10).join(", ")})` : ""),
        };
        errors.push({
          code: "PIN_NOT_FOUND",
          message:
            `"${component.part_number}" (${component.ref_id}) has no pin named "${logical}". ` +
            `Assigned positionally as a labelled mock.`,
          target: `${component.ref_id}.${logical}`,
          detail: { availablePins: match.availablePins ?? [] },
        });
      }
    }
  } else {
    for (const logical of logicalPins) {
      pinDetail[logical] = {
        pad: null,
        source: SOURCE.MOCK,
        real: false,
        reason: "no resolved footprint, so no catalogue pinout is available",
      };
    }
    if (logicalPins.length > 0) {
      errors.push({
        code: "PIN_NOT_FOUND",
        message:
          `No verified pinout for "${component.part_number}" (${component.ref_id}); ` +
          `all ${logicalPins.length} logical pin(s) assigned positionally as labelled mocks.`,
        target: component.ref_id,
        detail: { part_number: component.part_number },
      });
    }
  }

  // Component-level source reflects the weakest pin: fully real only when every
  // logical pin matched a real named pad.
  const allReal = logicalPins.length > 0 && realPins === logicalPins.length;
  const pins = field(
    allReal ? SOURCE.PARTS_ENGINE : realPins > 0 ? SOURCE.MOCK : SOURCE.MOCK,
    pinMap,
    {
      realCount: realPins,
      totalCount: logicalPins.length,
      perPin: pinDetail,
      ...(allReal
        ? {}
        : {
            reason:
              `${logicalPins.length - realPins} of ${logicalPins.length} logical pin(s) ` +
              `have no matching named pad; those are assigned positionally and must not be manufactured`,
          }),
    }
  );

  return {
    ref_id: component.ref_id,
    part_number: component.part_number,
    part_class: component.part_class,
    package: component.package,
    resolution: { footprint, pads, model_3d: model3d, symbol, pins },
    errors,
  };
}

/** Collect the logical pin names each component actually uses, from the nets. */
export function logicalPinsByRef(nets) {
  const map = {};
  for (const net of nets ?? []) {
    for (const connection of net.connections ?? []) {
      const [ref, pin] = String(connection).split(".");
      if (!ref || !pin) continue;
      (map[ref] ??= new Set()).add(pin);
    }
  }
  return Object.fromEntries(Object.entries(map).map(([ref, set]) => [ref, [...set]]));
}

/** Resolve every component in a design. */
export async function resolveComponents(components, nets = [], options = {}) {
  const resolved = [];
  const errors = [];
  const byRef = logicalPinsByRef(nets);

  for (const component of components) {
    const result = await resolveComponent(component, {
      ...options,
      logicalPinsByRef: byRef,
    });
    resolved.push(result);
    errors.push(...result.errors);
  }
  return { components: resolved, errors };
}

/**
 * Per-field tallies for the manifest. Deliberately NOT a per-component
 * real/mock verdict — that rollup is what the plan forbids.
 */
export function resolutionSummary(resolvedComponents) {
  const fields = ["footprint", "pads", "model_3d", "symbol", "pins"];
  const summary = {};
  for (const name of fields) {
    const tally = {};
    for (const component of resolvedComponents) {
      const source = component.resolution[name].source;
      tally[source] = (tally[source] ?? 0) + 1;
    }
    summary[name] = tally;
  }
  return summary;
}
