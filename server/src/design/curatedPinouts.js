import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Verified, part-specific pinouts.
 *
 * ── Why this is keyed by PART NUMBER, not package ───────────────────────────
 * `footprintMap` is keyed by *package*, because package determines geometry.
 * Pinouts are the opposite: `HY2111-GB` and `LP103SB6F` are both `SOT-23-6` and
 * have completely different pin functions. Attaching pin names to a package
 * entry would assign one part's pinout to every other part in that package —
 * a wrong-but-plausible pinout, the worst failure mode in this system.
 *
 * ── Why this doesn't violate D-023 ──────────────────────────────────────────
 * D-023 forbids *borrowing* pin names from a different footprint than the one
 * compiled, because pad numbering may not correspond. This table does not
 * borrow: each entry records a verified pin-number → function mapping for the
 * part, and each entry states the evidence that pad NUMBERING corresponds
 * between the compiled footprint and the source the mapping came from.
 *
 * An entry without that verification does not belong here.
 */

/**
 * Machine-verified entries from the dual-extraction batch. Kept in a separate
 * data file, not merged into the hand-written table above, so provenance is
 * never lost: these were accepted because two INDEPENDENT extractors agreed and
 * both passed both deterministic gates — not because a human read the datasheet.
 * See docs/POC_RESULTS.md and data/pin-batch-report.json.
 */
function autoVerified() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(
      fs.readFileSync(path.resolve(here, "../../data/auto-verified-pinouts.json"), "utf8")
    );
  } catch {
    return {};
  }
}

/**
 * part_number -> { package, pins: {FUNCTION: "pinN"}, evidence }
 *
 * `package` is a guard: resolution is refused if the upstream package disagrees,
 * since that would mean we are not looking at the part we think we are.
 */
const CURATED_PINOUTS = Object.freeze({
  /**
   * First entry sourced via the Phase 6 LLM-assisted pipeline rather than by
   * hand. It reached this table only after: the datasheet was fetched from LCSC,
   * Gemini proposed the mapping with a verbatim excerpt, both deterministic
   * gates passed, and a human confirmed it (`confirmedBy: "vrusha"`, recorded in
   * data/datasheet-extraction-cache.json).
   *
   * VDD is deliberately absent: LP103SB6F has no VDD pin. Its supply is `PS`
   * ("Power Source. Connection point for an external bypass capacitor for the
   * internally generated supply voltage"), so `VDD` correctly stays
   * PIN_NOT_FOUND rather than being mapped to something plausible.
   */
  LP103SB6F: {
    package: "SOT-23-6",
    pins: {
      GND: "pin2",
    },
    evidence:
      "Manufacturer datasheet (LP103S, via LCSC C387729): the Functional Pin " +
      'Description table row "GND  3  2  Ground." — columns are ' +
      "name | SOP8 pin | SOT23-6 pin, so GND is pin 2 in the SOT-23-6 package. " +
      "Verified verbatim against the extracted PDF text (gate 2 score 1.0) and " +
      "against the compiled 6-pad footprint (gate 1). Confirmed by a human " +
      "2026-08-09. NOTE: the datasheet's package top-view diagram extracts as " +
      '"1 2 3 4 5 6 D+ D- PS QC_EN GND FBO", which naively reads GND=pin5; the ' +
      "pin-description table is authoritative and self-consistent (D+=1, GND=2, " +
      "FBO=3, QC_EN=4, PS=5, D-=6 — each pin used exactly once). " +
      "Pad-numbering correspondence with footprinter's `sot23_6` holds for the " +
      "same reason recorded on the HY2111-GB entry below.",
  },

  "HY2111-GB": {
    package: "SOT-23-6",
    pins: {
      OD: "pin1",
      CS: "pin2",
      OC: "pin3",
      NC: "pin4",
      VDD: "pin5",
      VSS: "pin6",
    },
    evidence:
      "Pin functions come from the LCSC/EasyEDA catalogue entry for this exact " +
      "part (C82747). Pad-numbering correspondence with the compiled footprinter " +
      "`sot23_6` was verified empirically: both place pin1-3 sequentially along " +
      "one side and pin4-6 along the other in the same order, so pin N is the " +
      "same physical pin in both. The two footprints differ by a 180 degree " +
      "rotation, which changes board orientation but not pin identity.",
  },
});

/**
 * Look up a verified pinout.
 *
 * @param {string} partNumber
 * @param {string} pkg upstream package string, used as a guard
 * @returns {{ok: true, pins: object, evidence: string}
 *          |{ok: false, reason: string}}
 */
export function curatedPinout(partNumber, pkg) {
  const name = String(partNumber ?? "").trim();
  const entry = CURATED_PINOUTS[name];

  if (!entry) {
    // Fall back to a dual-extraction-verified entry, if one exists for this
    // exact part AND package.
    const auto = autoVerified()[`${name}::${String(pkg ?? "").trim()}`];
    if (auto) {
      return {
        ok: true,
        pins: Object.fromEntries(Object.entries(auto.pins).map(([fn, d]) => [fn, d.pad])),
        evidence:
          `Verified by ${auto.verifiedBy} on ${auto.verifiedAt} against ${auto.datasheetUrl}. ` +
          `Two independent extractions agreed and both passed both deterministic gates.`,
        source: "dual_extraction",
      };
    }
    return { ok: false, reason: "no curated pinout for this part number" };
  }

  const normalize = (value) => String(value ?? "").trim().replace(/\s+/g, "").toUpperCase();
  if (normalize(entry.package) !== normalize(pkg)) {
    return {
      ok: false,
      reason:
        `curated pinout for "${partNumber}" is for package "${entry.package}" but ` +
        `upstream says "${pkg}" — refusing to apply it`,
    };
  }

  return { ok: true, pins: { ...entry.pins }, evidence: entry.evidence };
}

export function curatedPinoutParts() {
  return Object.keys(CURATED_PINOUTS);
}
