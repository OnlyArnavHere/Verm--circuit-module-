/**
 * Package string -> tscircuit footprint resolution.
 *
 * The Hardware Agent's `package` field is a manufacturer/catalogue package name
 * ("QFN-16-EP(4x4)", "MAPBGA-289"). It is NOT a tscircuit footprint. Phase 2
 * measured this directly: of 10 distinct package strings in our fixtures, 8 are
 * rejected outright by tscircuit and 1 (`DFN-8-EP(2x3)`) is worse — it parses
 * with zero errors and produces ZERO PADS.
 *
 * ── The rule this module exists to enforce ──────────────────────────────────
 * Never substitute a lookalike. A footprint whose pad COUNT matches is not
 * necessarily a footprint whose pad GEOMETRY matches, and the difference is
 * invisible in every render while being fatal at the fab. `SOP-16` and `soic16`
 * both have 16 pads and different pitch conventions; `QFN-16-EP(4x4)` has an
 * exposed thermal pad that plain `qfn16` lacks; `MAPBGA-289`'s ball pitch is not
 * derivable from its name.
 *
 * So: an entry enters CURATED only with recorded evidence of BOTH pad count and
 * geometry. Everything else returns FOOTPRINT_NOT_FOUND. An explicit error is
 * cheap; a wrong footprint survives review and dies at the fab.
 */

/**
 * Verified package -> footprint mappings.
 *
 * Every entry must carry:
 *   footprint         exact tscircuit footprint string
 *   expectedPadCount  independently asserted after compile (see assertions.js)
 *   evidence          how this was confirmed — no entry without it
 */
const CURATED = Object.freeze({
  "SOT-23-6": {
    footprint: "sot23_6",
    expectedPadCount: 6,
    evidence:
      "Phase 2 spike: tscircuit renders 6 SMT pads, no errors/warnings. " +
      "SOT-23-6 is a single standardised JEDEC body (2.9x1.6mm, 0.95mm pitch) " +
      "with no competing variant, so name alone determines geometry.",
  },
});

/**
 * Footprints that exist in tscircuit and have the right pad COUNT, but whose
 * geometric equivalence to the package string is unproven. Surfaced in the error
 * payload so the agent layer can explain the near miss and a human can promote
 * one to CURATED with evidence. NEVER auto-selected.
 */
const UNVERIFIED_CANDIDATES = Object.freeze({
  "SOIC-8": [{ footprint: "soic8", padCount: 8, blocker: "pitch/body not verified against the part datasheet" }],
  "SOP-16": [{ footprint: "soic16", padCount: 16, blocker: "SOP and SOIC use different pitch conventions" }],
  "SSOP-24": [{ footprint: "ssop24", padCount: 24, blocker: "body width variants (SSOP vs QSOP) not disambiguated" }],
  "DIP-18": [{ footprint: "dip18", padCount: 18, blocker: "through-hole drill sizes not verified" }],
  "LQFP-48(7x7)": [{ footprint: "lqfp48", padCount: 48, blocker: "7x7 body implied but pitch not verified" }],
  "LQFP-32(7x7)": [{ footprint: "lqfp32", padCount: 32, blocker: "7x7 body implied but pitch not verified" }],
  "MAPBGA-289": [{ footprint: "bga289", padCount: 289, blocker: "ball pitch and matrix layout not derivable from the name" }],
  "QFN-16-EP(4x4)": [
    { footprint: "qfn16", padCount: 16, blocker: "source package has an exposed thermal pad (EP); qfn16 does not" },
  ],
  "DFN-8-EP(2x3)": [
    {
      footprint: null,
      padCount: 0,
      blocker:
        "DANGEROUS: tscircuit parses this string with zero errors and produces ZERO PADS " +
        "(Phase 2 finding R1). Must never be passed through.",
    },
  ],
});

export const FOOTPRINT_SOURCE = Object.freeze({
  CURATED: "curated",
});

/** Trim and collapse whitespace; casing/punctuation are preserved deliberately. */
function normalizePackage(pkg) {
  return String(pkg ?? "").trim().replace(/\s+/g, "");
}

/**
 * Resolve a package string to a footprint.
 *
 * @param {string} pkg e.g. "SOT-23-6"
 * @returns {{ok: true, footprint: string, expectedPadCount: number, source: string, evidence: string}
 *          |{ok: false, code: "FOOTPRINT_NOT_FOUND", message: string, package: string, candidates: object[]}}
 */
export function resolveFootprint(pkg) {
  const normalized = normalizePackage(pkg);

  if (!normalized) {
    return {
      ok: false,
      code: "FOOTPRINT_NOT_FOUND",
      message: "No package string supplied; cannot resolve a footprint.",
      package: String(pkg ?? ""),
      candidates: [],
    };
  }

  const entry = CURATED[normalized];
  if (entry) {
    return {
      ok: true,
      footprint: entry.footprint,
      expectedPadCount: entry.expectedPadCount,
      source: FOOTPRINT_SOURCE.CURATED,
      evidence: entry.evidence,
    };
  }

  const candidates = UNVERIFIED_CANDIDATES[normalized] ?? [];
  return {
    ok: false,
    code: "FOOTPRINT_NOT_FOUND",
    message:
      `No verified footprint for package "${normalized}". ` +
      (candidates.length
        ? `${candidates.length} unverified candidate(s) exist but were NOT substituted: ` +
          candidates
            .map((c) => `${c.footprint ?? "(none)"} — ${c.blocker}`)
            .join("; ")
        : "No candidate footprint is known for this package."),
    package: normalized,
    candidates,
  };
}

/** Exposed for docs/tests — the set of packages we can currently resolve. */
export function curatedPackages() {
  return Object.keys(CURATED);
}
