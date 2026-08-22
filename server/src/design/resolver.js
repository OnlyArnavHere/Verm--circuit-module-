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
import { curatedPinout } from "./curatedPinouts.js";
import { classifyUnresolvedPin, CAPABILITY_VERDICT } from "./capabilityCheck.js";
import { resolveRole, allocateGpio, ALLOCATED_ROLES } from "./roleMap.js";
import { pinRequestsByRef } from "./normalizeUpstream.js";

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
  // Corrections and allocations are never silent (PROJECT_PLAN section 5).
  const modifications = [];

  // --- footprint + pads ----------------------------------------------------
  //
  // ORDER: part-specific first, package-generic second. (D-061)
  //
  // The parts engine matches this exact PART NUMBER with an exact package check,
  // so it yields the manufacturer's own footprint for this part. The curated
  // table is keyed by PACKAGE, so it is generic to every part sharing that body.
  // More specific evidence wins, and both are equally verified — this does NOT
  // loosen D-010, which still requires the package to match exactly.
  //
  // Measured cost of the old order: `sot23_6` (curated, generic) shadowed
  // `jlcpcb:C82747` / `jlcpcb:C387729` for the two SOT-23-6 parts. Same 6 pads,
  // identical pad numbering — but the catalogue footprints also carry real pin
  // names AND real 3D models, which were being discarded.
  let footprint;
  let pads;

  const curated = resolveFootprint(component.package);
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
  } else if (curated.ok) {
    // Package-generic fallback: used when the catalogue has no entry for this
    // exact part, which is precisely what the curated table is for.
    footprint = field(SOURCE.CURATED, curated.footprint, { evidence: curated.evidence });
    pads = field(SOURCE.CURATED, null, { expectedCount: curated.expectedPadCount });
  } else {
      // mock — explicit, with the reason resolution failed
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

  // --- 3D model ------------------------------------------------------------
  // NEVER claimed real here. A resolved footprint does NOT imply a 3D model
  // exists: `HY2111-GB` resolves via the curated table yet has no model at all.
  // The earlier version inherited the footprint's source and set a
  // `pendingCompileConfirmation` flag that nothing ever read, producing a
  // false `real: true` in the manifest — the exact failure this system exists to
  // prevent. The claim is now made only by confirmModel3d(), from actual
  // cad_component elements in the compiled output. (D-027)
  const model3d = field(SOURCE.UNRESOLVED, null, {
    unconfirmed: true,
    reason: "3D model presence is unknown until the design is compiled",
  });

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
  // Schema 2.0 sends {interface, role} and no pin name; schema 1.0 sends an
  // asserted pin name. `requests` carries whichever applies, already normalized.
  const requests = options.pinRequestsByRef?.[component.ref_id]
    ?? [...(options.logicalPinsByRef?.[component.ref_id] ?? [])]
      .sort()
      .map((logicalPin) => ({ interface: null, role: null, logicalPin, roleIsDeclared: false }));
  // Label a request for the maps/messages: "I2C/CLOCK" (v2) or "SDA" (v1).
  // The label keys pinMap/pinDetail, so it must be UNIQUE per request. A
  // per-net role (GPIO, chip select) legitimately appears more than once on one
  // part -- two GPIO nets on the same MCU are two different pads -- so the net
  // name is folded in. Without it both requests collapsed onto one key and the
  // second silently overwrote the first, hiding a pad that was never assigned.
  // Same defect class as the chip-select collision, one layer up.
  const labelOf = (r) =>
    r.roleIsDeclared
      ? ALLOCATED_ROLES.has(r.role)
        ? `${r.interface}/${r.role}@${r.net}`
        : `${r.interface}/${r.role}`
      : r.logicalPin;
  const logicalPins = requests.map(labelOf);
  const pinMap = {};
  const pinDetail = {};
  const allocatedPads = new Set();
  let realPins = 0;
  // Provenance of the pin mapping as a whole: curated (part-specific verified
  // table) or parts_engine (names read off the catalogue footprint).
  let pinsResolvedFrom = SOURCE.PARTS_ENGINE;

  if (isReal(footprint.source) && footprint.value && logicalPins.length > 0) {
    // Curated part-specific pinout wins: it is human-verified and, unlike the
    // catalogue extraction, is available for footprints that expose only
    // positional pins (e.g. footprinter's sot23_6).
    const curatedPins = curatedPinout(component.part_number, component.package);
    const cataloguePins = await extractPinout(footprint.value, options);
    // `padCount` comes from the REAL footprint even when curated names win.
    //
    // It was previously omitted on the curated branch, and capabilityCheck needs
    // it to assert completeness — so the most trustworthy pin source was the one
    // that could never support a capability claim, and every unresolved pin on a
    // curated part silently degraded from PART_CAPABILITY_MISMATCH to
    // PIN_NOT_FOUND ("no confirmed capability data for this part").
    //
    // It must NOT be derived from the curated pins themselves. The curated table
    // is not required to be exhaustive: LP103SB6F's entry is a single pin (GND)
    // on a 6-pad SOT-23-6, deliberately, so that its absent VDD stays
    // PIN_NOT_FOUND instead of being mapped to something plausible. Counting its
    // own pads would make it "1 of 1 named" — complete — and turn every other
    // function on that part into a confident false mismatch.
    //
    // If the catalogue lookup fails we leave padCount undefined, which keeps
    // capabilityConfirmed false: an unknown pad count must never read as a
    // confirmed-complete part.
    const pinout = curatedPins.ok
      ? {
          ok: true,
          pins: curatedPins.pins,
          ...(cataloguePins.ok ? { padCount: cataloguePins.padCount } : {}),
        }
      : cataloguePins;
    const pinSource = curatedPins.ok ? SOURCE.CURATED : SOURCE.PARTS_ENGINE;
    pinsResolvedFrom = pinSource;

    for (const request of requests) {
      const logical = labelOf(request);
      let match = { ok: false };
      let allocatedGpio = false;
      if (pinout.ok) {
        if (request.roleIsDeclared) {
          // v2: resolve the DECLARED role against the part's real pin names.
          if (request.interface === "GPIO") {
            // GPIO is a choice, not a lookup — allocate deterministically and
            // record it below as a modification. Never silent.
            match = allocateGpio(pinout, allocatedPads);
            allocatedGpio = match.ok;
          } else {
            // allocatedPads lets a per-net role (chip select) claim a DISTINCT
            // pad per net instead of every net getting the same first match.
            match = resolveRole(
              request.interface, request.role, pinout, matchLogicalPin, allocatedPads,
            );
          }
        } else {
          // v1: match the asserted (fabricated, per D-076) pin name by string.
          match = matchLogicalPin(request.logicalPin, pinout);
        }
      }
      if (match.ok) {
        allocatedPads.add(match.pad);
        if (allocatedGpio) {
          modifications.push({
            target: `${component.ref_id}.${logical}`,
            originalValue: null,
            correctedValue: match.matchedName,
            reason:
              `GPIO is an allocation, not a lookup: upstream asked for a GPIO connection ` +
              `without naming a pad, so the lowest-numbered unallocated general-purpose ` +
              `I/O pin ("${match.matchedName}") was assigned deterministically.`,
            detectedBy: "GPIO_ALLOCATED",
          });
        }
        pinMap[logical] = match.pad;
        pinDetail[logical] = {
          pad: match.pad,
          source: pinSource,
          real: true,
          via: match.via,
          ...(match.reason ? { reason: match.reason } : {}),
          ...(curatedPins.ok ? { evidence: curatedPins.evidence } : {}),
        };
        realPins += 1;
      } else {
        // Not merely "unresolved": if the part's full pin set is confirmed and
        // this function is not in it, that is a capability mismatch — an
        // upstream error rather than something more research would fix.
        // Classify against a concrete function name: for v2 use the first
        // candidate the role maps to, since that is what was actually sought.
        const probe = request.roleIsDeclared
          ? (match.tried?.[0] ?? request.role)
          : request.logicalPin;
        const verdict = classifyUnresolvedPin(probe, pinout);
        const isMismatch = verdict.code === CAPABILITY_VERDICT.MISMATCH;

        pinDetail[logical] = {
          pad: null,
          // Schema 2.0 has NO mock path: an unresolvable role stays unresolved
          // and blocks compilation. v1 keeps its labelled-mock behaviour so the
          // existing fixtures still exercise the legacy path.
          source: request.roleIsDeclared ? SOURCE.UNRESOLVED : SOURCE.MOCK,
          real: false,
          code: verdict.code,
          capabilityConfirmed: verdict.capabilityConfirmed,
          reason: verdict.reason,
        };
        errors.push({
          code: verdict.code,
          message: isMismatch
            ? `"${component.part_number}" (${component.ref_id}) does not provide "${logical}". ` +
              `${verdict.reason}`
            : `"${component.part_number}" (${component.ref_id}) has no resolved pin "${logical}". ` +
              `${verdict.reason}`,
          target: `${component.ref_id}.${logical}`,
          detail: {
            availablePins: verdict.availablePins ?? match.availablePins ?? [],
            capabilityConfirmed: verdict.capabilityConfirmed,
          },
        });
      }
    }
  } else {
    for (const request of requests) {
      const logical = labelOf(request);
      pinDetail[logical] = {
        pad: null,
        // See above: schema 2.0 never falls back to a positional mock.
        source: request.roleIsDeclared ? SOURCE.UNRESOLVED : SOURCE.MOCK,
        real: false,
        reason: "no resolved footprint, so no catalogue pinout is available",
      };
    }
    if (logicalPins.length > 0) {
      errors.push({
        code: "PIN_NOT_FOUND",
        message:
          `No verified pinout for "${component.part_number}" (${component.ref_id}); ` +
          (requests.some((r) => r.roleIsDeclared)
            ? `all ${logicalPins.length} role(s) left UNRESOLVED — schema 2.0 has no mock fallback.`
            : `all ${logicalPins.length} logical pin(s) assigned positionally as labelled mocks.`),
        target: component.ref_id,
        detail: { part_number: component.part_number },
      });
    }
  }

  // Component-level source reflects the weakest pin: fully real only when every
  // logical pin matched a real named pad.
  const allReal = logicalPins.length > 0 && realPins === logicalPins.length;
  // A v2 request that failed leaves the mapping UNRESOLVED, which must never
  // reach the compiler; a v1 failure degrades to a labelled MOCK as before.
  const anyDeclaredUnresolved = requests.some(
    (r) => r.roleIsDeclared && pinDetail[labelOf(r)]?.real === false
  );
  const pins = field(
    // Real only when EVERY logical pin matched; a single positional fallback
    // makes the whole mapping unsafe to manufacture from.
    allReal ? pinsResolvedFrom : anyDeclaredUnresolved ? SOURCE.UNRESOLVED : SOURCE.MOCK,
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
    modifications,
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
  const modifications = [];
  // `nets` may be raw v1 nets or already-normalized nets. pinRequestsByRef
  // understands the normalized shape; logicalPinsByRef remains the v1 fallback.
  const requestsByRef = options.pinRequestsByRef
    ?? (nets.some((n) => Array.isArray(n?.members)) ? pinRequestsByRef(nets) : null);
  const byRef = requestsByRef ? null : logicalPinsByRef(nets);

  for (const component of components) {
    const result = await resolveComponent(component, {
      ...options,
      ...(requestsByRef ? { pinRequestsByRef: requestsByRef } : { logicalPinsByRef: byRef }),
    });
    resolved.push(result);
    errors.push(...result.errors);
    modifications.push(...(result.modifications ?? []));
  }
  return { components: resolved, errors, modifications };
}

/**
 * Confirm 3D-model claims against compiled ground truth.
 *
 * MUST be called after compilation and before the manifest is written. A
 * component's `model_3d` is `real` only when the compiled Circuit JSON contains
 * a `cad_component` for it carrying an actual model reference — not because its
 * footprint resolved. Mutates each component's `resolution.model_3d` in place
 * and returns any MODEL_3D_NOT_FOUND findings.
 *
 * @param {Array<object>} circuitJson compiled output
 * @param {Array<object>} resolvedComponents from resolveComponents
 */
export function confirmModel3d(circuitJson, resolvedComponents) {
  const errors = [];

  // ref_id -> cad_component, resolved via source_component -> pcb_component.
  const sourceNames = new Map();
  for (const element of circuitJson ?? []) {
    if (element?.type === "source_component") {
      sourceNames.set(element.source_component_id, element.name);
    }
  }
  const refByPcbId = new Map();
  for (const element of circuitJson ?? []) {
    if (element?.type === "pcb_component") {
      refByPcbId.set(element.pcb_component_id, sourceNames.get(element.source_component_id));
    }
  }
  const cadByRef = new Map();
  for (const element of circuitJson ?? []) {
    if (element?.type !== "cad_component") continue;
    const ref = refByPcbId.get(element.pcb_component_id);
    if (ref) cadByRef.set(ref, element);
  }

  const modelUrlOf = (cad) =>
    cad?.model_obj_url ?? cad?.model_stl_url ?? cad?.model_gltf_url ?? cad?.model_glb_url ?? null;

  for (const component of resolvedComponents ?? []) {
    const cad = cadByRef.get(component.ref_id);
    const url = modelUrlOf(cad);
    const hasJscad = Boolean(cad?.model_jscad);

    if (url) {
      component.resolution.model_3d = field(SOURCE.PARTS_ENGINE, url, {
        confirmedFromCompiledOutput: true,
      });
    } else if (hasJscad) {
      // A procedurally-generated body: deterministic, but not the real part model.
      component.resolution.model_3d = field(SOURCE.GENERATED, "jscad", {
        confirmedFromCompiledOutput: true,
        reason: "procedural body generated from the footprint; not the part's own 3D model",
      });
      errors.push({
        code: "MODEL_3D_NOT_FOUND",
        severity: "warning",
        message:
          `No catalogue 3D model for "${component.part_number}" (${component.ref_id}); ` +
          `the 3D output contains a generated body, not the real part.`,
        target: component.ref_id,
        detail: {},
      });
    } else {
      component.resolution.model_3d = field(SOURCE.MOCK, null, {
        confirmedFromCompiledOutput: true,
        reason: cad
          ? "compiled cad_component carries no model reference"
          : "no cad_component was produced for this component",
      });
      errors.push({
        code: "MODEL_3D_NOT_FOUND",
        severity: "warning",
        message:
          `No 3D model for "${component.part_number}" (${component.ref_id}) — ` +
          `this component is absent from the 3D output.`,
        target: component.ref_id,
        detail: {},
      });
    }
  }

  return { errors, confirmed: resolvedComponents?.length ?? 0 };
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
