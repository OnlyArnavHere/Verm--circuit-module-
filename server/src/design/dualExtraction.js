/**
 * Dual-independent-extraction verification (PROJECT_PLAN Phase 6).
 *
 * Replaces the per-pin human gate for the unambiguous majority, without
 * lowering the evidence bar:
 *
 *   datasheet ──▶ Extractor A ──▶ gate1 + gate2
 *                                     │ (passed)
 *                                     ▼
 *                 Extractor B ──▶ gate1 + gate2        ← BLIND to A
 *                                     │
 *                                     ▼
 *                 same physical pin?  ── yes ─▶ AUTO-ACCEPT
 *                                     └─ no  ─▶ HUMAN REVIEW (both shown)
 *
 * ── The property that makes this worth doing ────────────────────────────────
 * Extractor B never sees Extractor A's answer or evidence. It re-extracts from
 * scratch. That is *independent reproduction*, not confirmation — a second pass
 * shown the first answer and asked "is this right?" anchors on it and brings no
 * structurally different failure mode, since it is still pattern-matching the
 * same ambiguous text.
 *
 * The concrete case this is built for: LP103SB6F's datasheet contains BOTH a
 * per-package table giving the correct GND=pin2 AND a package diagram that reads
 * as GND=pin5. Both are genuinely verbatim; both pass both deterministic gates.
 * Only disagreement between independent readings catches it.
 */
import { buildExtractorTiers, callWithRotation } from "./extractorTiers.js";
import {
  gateStructural,
  gateEvidence,
  gateEvidenceMentionsPin,
  buildPrompt,
  callGemini,
  selectPinSections,
} from "./datasheetExtraction.js";

/**
 * Extractor B's key, whatever it is called in `.env`. Env vars are
 * case-sensitive, and this key has been spelled `Grok_API_KEY` while holding
 * both x.ai and (intended) Groq values — so accept the spellings and let the
 * *prefix* decide the provider rather than the variable name.
 */
export const extractorBKey = () =>
  process.env.GROQ_API_KEY ||
  process.env.Groq_API_KEY ||
  process.env.Grok_API_KEY ||
  process.env.GROK_API_KEY ||
  process.env.XAI_API_KEY ||
  null;

/**
 * Two different vendors with confusingly similar names, and the key prefix is
 * the only reliable discriminator:
 *   `gsk_…` -> Groq   (api.groq.com, serves Llama/Mixtral/Gemma)
 *   `xai-…` -> x.ai   (api.x.ai, serves Grok)
 * Both are OpenAI-compatible, so only the base URL and default model differ.
 */
export function detectProvider(apiKey) {
  const key = String(apiKey ?? "");
  if (key.startsWith("gsk_")) {
    return {
      name: "groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      defaultModel: "llama-3.3-70b-versatile",
    };
  }
  if (key.startsWith("xai-")) {
    return {
      name: "xai-grok",
      url: "https://api.x.ai/v1/chat/completions",
      defaultModel: "grok-3",
    };
  }
  return null;
}

/** Extractor B — a genuinely different model family from Gemini, by design. */
export async function callExtractorB(
  prompt,
  { fetchImpl = fetch, model, apiKey = extractorBKey() } = {}
) {
  if (!apiKey) {
    return { ok: false, reason: "no Extractor B API key set; no model call was made" };
  }

  const provider = detectProvider(apiKey);
  if (!provider) {
    return {
      ok: false,
      reason:
        "Extractor B key matches no known provider (expected a Groq key starting " +
        '"gsk_" or an x.ai key starting "xai-")',
    };
  }

  try {
    const response = await fetchImpl(provider.url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: model ?? provider.defaultModel,
        messages: [
          // Groq rejects `response_format: json_object` unless the word "json"
          // appears in the messages. This is provider plumbing, not content:
          // the *user* prompt stays byte-identical to Extractor A's, so the
          // blindness property is unaffected.
          { role: "system", content: "Respond with a single JSON object and nothing else." },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      let detail = body.slice(0, 200);
      try {
        const parsed = JSON.parse(body);
        detail = (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ?? detail;
      } catch {
        /* keep raw */
      }
      return { ok: false, reason: `${provider.name} returned HTTP ${response.status}: ${detail}` };
    }

    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content ?? "";
    return { ok: true, raw: text, parsed: JSON.parse(text) };
  } catch (error) {
    return { ok: false, reason: `${provider.name} call failed: ${error.message}` };
  }
}

/**
 * How a result was verified. Recorded on EVERY result, not just degraded ones,
 * so a reviewer reading the record later can tell what evidence stood behind it
 * without having watched the run.
 */
export const VERIFICATION_MODE = Object.freeze({
  DUAL: "DUAL", // two independent extractors ran
  GEMINI_ONLY: "GEMINI_ONLY", // Extractor B unavailable — degraded
  GROQ_ONLY: "GROQ_ONLY", // Extractor A unavailable — degraded
  NONE: "NONE", // neither ran
});

export const isDegraded = (mode) =>
  mode === VERIFICATION_MODE.GEMINI_ONLY || mode === VERIFICATION_MODE.GROQ_ONLY;

/**
 * Why single-provider results never auto-accept, however clean they look:
 * the LP103SB6F near-miss proved a single gate-passing extraction can be
 * confidently WRONG. Extractor A alone, reading only the package diagram,
 * passed every deterministic gate and still produced pin5 instead of pin2.
 * Gates check internal consistency — that a claim is well-formed and quoted
 * from the source — not correctness. Independent agreement supplies the missing
 * evidence, so a degraded result has an evidentiary GAP, not merely lower
 * confidence.
 */
export const DEGRADED_WARNING =
  "Single-provider (degraded) verification: only one extractor ran, so this " +
  "result has NOT been independently reproduced. Deterministic gates passed, " +
  "but gates check internal consistency, not correctness — a single " +
  "gate-passing extraction has been observed to be confidently wrong " +
  "(LP103SB6F near-miss). Requires human review before it can be trusted.";

export const OUTCOME = Object.freeze({
  AUTO_ACCEPTED: "auto_accepted", // both extractors agreed, both passed both gates
  NEEDS_REVIEW: "needs_review", // disagreement, or a gate failure on either side
  NOT_FOUND: "not_found", // genuinely unresolvable: extractors ran and found nothing
  // The extractor never actually ran (quota, rate limit, transport). This is NOT
  // PIN_NOT_FOUND: "we tried and it is not there" and "we never tried" are
  // different claims, and recording the second as the first is a lie about
  // coverage. Keeping them distinct is what stops an aborted batch from looking
  // like a completed one.
  NOT_ATTEMPTED: "not_attempted",
});

/**
 * Default extractor pair, each backed by a credential chain.
 *
 * Rotation happens INSIDE an extractor: a key running out of quota moves to the
 * next credential for the same extractor and is invisible to the comparator.
 * `verification_mode` only degrades when an extractor exhausts every tier.
 */
export const defaultExtractors = () => {
  const tiers = buildExtractorTiers();
  return [
    {
      id: "A",
      name: `gemini(${tiers.A.length} key${tiers.A.length === 1 ? "" : "s"})`,
      tiers: tiers.A,
      call: (prompt, options) => callWithRotation(tiers.A, prompt, options),
    },
    {
      id: "B",
      name:
        tiers.B.length > 0
          ? `${[...new Set(tiers.B.map((t) => t.provider))].join("+")}(${tiers.B.length} tier${tiers.B.length === 1 ? "" : "s"})`
          : "extractor-b(unconfigured)",
      tiers: tiers.B,
      call: (prompt, options) => callWithRotation(tiers.B, prompt, options),
    },
  ];
};

/**
 * Run one extractor and gate its claims.
 *
 * `datasheetText` is passed per extractor rather than shared, so a controlled
 * test can restrict one extractor's view of the source. In production both
 * receive the identical full text.
 */
async function runExtractor(extractor, { partNumber, pkg, neededPins, datasheetText, footprintPads, padAliases, padVocabulary, fetchImpl }) {
  const prompt = buildPrompt({
    partNumber,
    package: pkg,
    neededPins,
    datasheetText,
    footprintPads: padVocabulary ?? footprintPads,
  });

  const response = await extractor.call(prompt, { fetchImpl, model: extractor.model });
  if (!response.ok) {
    // A transport/quota failure is a PROVIDER failure — distinct from the model
    // running fine and declining to answer. Only the former triggers failover.
    return {
      id: extractor.id,
      name: extractor.name,
      ok: false,
      // Only a provider failure once EVERY credential tier has been tried —
      // a single exhausted key rotates rather than degrading the run.
      status: "provider_failure",
      reason: response.reason,
      tiersTried: response.tiersTried ?? null,
      claims: [],
    };
  }

  const claims = (response.parsed?.pins ?? []).map((claim) => {
    const structural = gateStructural(claim, footprintPads, padAliases);
    // Evidence is checked against the text THIS extractor was given, so a
    // restricted view cannot be rescued by text it never saw.
    const evidence = gateEvidence(claim, datasheetText);
    // Gate 3: the excerpt must actually mention the claimed pin (D-048).
    const relevance = gateEvidenceMentionsPin(claim, footprintPads, padAliases);
    return {
      logical_pin: claim.logical_pin,
      // Compare on the NORMALIZED pin so "5" and "pin5" are not mistaken for a
      // disagreement — a formatting difference is not a substantive one.
      physical_pin: structural.normalizedPin ?? claim.physical_pin,
      rawPhysicalPin: claim.physical_pin,
      evidence: claim.evidence,
      reportedConfidence: claim.confidence ?? null,
      gates: { structural, evidence, relevance },
      passed: structural.pass && evidence.pass && relevance.pass,
    };
  });

  return {
    id: extractor.id,
    name: extractor.name,
    ok: true,
    status: claims.length > 0 ? "ok" : "declined",
    // Which credential actually served this, for the provenance record.
    servedBy: response.servedBy ?? null,
    tiersTried: response.tiersTried ?? null,
    claims,
  };
}

const findClaim = (result, logicalPin) =>
  result.claims.find((claim) => claim.logical_pin === logicalPin) ?? null;

/**
 * Compare two independent extractions for one logical pin.
 * Auto-accept requires: both produced a claim, both passed BOTH gates, and both
 * landed on the same physical pin.
 */
export function comparePin(logicalPin, resultA, resultB, mode = VERIFICATION_MODE.DUAL) {
  const a = findClaim(resultA, logicalPin);
  const b = findClaim(resultB, logicalPin);
  const base = { logical_pin: logicalPin, a, b, verification_mode: mode };

  // ---- neither extractor ran: nothing was attempted -----------------------
  if (mode === VERIFICATION_MODE.NONE) {
    return {
      ...base,
      outcome: OUTCOME.NOT_ATTEMPTED,
      reason:
        `no extractor ran (A: ${resultA.reason ?? "n/a"}; B: ${resultB.reason ?? "n/a"})`,
    };
  }

  // ---- degraded: exactly one provider was available -----------------------
  if (isDegraded(mode)) {
    const claim = mode === VERIFICATION_MODE.GEMINI_ONLY ? a : b;
    const downProvider = mode === VERIFICATION_MODE.GEMINI_ONLY ? resultB : resultA;

    if (!claim) {
      return {
        ...base,
        outcome: OUTCOME.NOT_FOUND,
        degraded: true,
        reason: `the only available extractor (${mode}) returned no claim for this pin`,
      };
    }
    if (!claim.passed) {
      return {
        ...base,
        outcome: OUTCOME.NEEDS_REVIEW,
        degraded: true,
        degradedReason: "provider_outage",
        warning: DEGRADED_WARNING,
        reason: `single-provider (${mode}) result failed a deterministic gate`,
      };
    }
    // Passed every gate — and still does NOT auto-accept. See DEGRADED_WARNING.
    return {
      ...base,
      outcome: OUTCOME.NEEDS_REVIEW,
      degraded: true,
      degradedReason: "provider_outage",
      physical_pin: claim.physical_pin,
      warning: DEGRADED_WARNING,
      reason:
        `single-provider (${mode}) result passed all gates but was NOT independently ` +
        `reproduced — the other provider was unavailable (${downProvider.reason ?? "unavailable"}). ` +
        `Routed to review because gates verify consistency, not correctness.`,
    };
  }

  // ---- dual mode ----------------------------------------------------------
  if (!a && !b) {
    return { ...base, outcome: OUTCOME.NOT_FOUND, reason: "neither extractor returned this pin" };
  }
  if (!a || !b) {
    const which = a ? "B" : "A";
    return {
      ...base,
      outcome: OUTCOME.NEEDS_REVIEW,
      degradedReason: "extractor_conflict",
      reason: `only one extractor returned this pin (extractor ${which} did not)`,
    };
  }
  if (!a.passed || !b.passed) {
    const failed = [!a.passed && "A", !b.passed && "B"].filter(Boolean).join(" and ");
    return {
      ...base,
      outcome: OUTCOME.NEEDS_REVIEW,
      degradedReason: "extractor_conflict",
      reason: `extractor ${failed} failed a deterministic gate`,
    };
  }
  if (String(a.physical_pin).toUpperCase() !== String(b.physical_pin).toUpperCase()) {
    return {
      ...base,
      outcome: OUTCOME.NEEDS_REVIEW,
      degradedReason: "extractor_conflict",
      reason:
        `independent extractions DISAGREE: A says ${a.physical_pin}, B says ${b.physical_pin}. ` +
        `Both passed all gates, so both excerpts are genuinely in the datasheet — ` +
        `a human must decide which reading is authoritative.`,
    };
  }

  return {
    ...base,
    outcome: OUTCOME.AUTO_ACCEPTED,
    physical_pin: a.physical_pin,
    reason: `both extractors independently extracted ${a.physical_pin}, both passed all gates`,
  };
}

/**
 * Full dual-extraction run for one part.
 *
 * @param {object} params
 * @param {string[]} params.neededPins
 * @param {string} params.datasheetText full extracted datasheet text
 * @param {string[]} params.footprintPads pads on the compiled footprint
 * @param {Array} [params.extractors] override for tests / restricted-view runs
 */
export async function extractWithVerification({
  partNumber,
  pkg,
  neededPins,
  datasheetText,
  footprintPads,
  padAliases,
  padVocabulary,
  extractors = defaultExtractors(),
  fetchImpl = fetch,
  // Providers currently believed down. Skipped without a call, but the caller
  // is expected to retry them periodically — one outage must not downgrade the
  // whole run.
  unavailable = {},
}) {
  const [extractorA, extractorB] = extractors;
  const shared = selectPinSections(datasheetText, neededPins);
  const common = { partNumber, pkg, neededPins, footprintPads, padAliases, padVocabulary, fetchImpl };

  const skipped = (extractor, why) => ({
    id: extractor.id,
    name: extractor.name,
    ok: false,
    status: "skipped",
    reason: why,
    claims: [],
  });

  // ---- Extractor A --------------------------------------------------------
  let resultA = unavailable.A
    ? skipped(extractorA, `provider marked unavailable: ${unavailable.A}`)
    : await runExtractor(extractorA, { ...common, datasheetText: extractorA.datasheetText ?? shared });

  // ---- Extractor B --------------------------------------------------------
  // Normally B runs only when A produced something worth corroborating. But if A
  // is DOWN, B must run on its own — that is the whole point of failover.
  const aDown = resultA.status === "provider_failure" || resultA.status === "skipped";
  const aWorthCorroborating = resultA.ok && resultA.claims.some((claim) => claim.passed);

  let resultB;
  if (unavailable.B) {
    resultB = skipped(extractorB, `provider marked unavailable: ${unavailable.B}`);
  } else if (aDown || aWorthCorroborating) {
    resultB = await runExtractor(extractorB, { ...common, datasheetText: extractorB.datasheetText ?? shared });
  } else {
    // Not a failure: A ran fine and produced nothing to corroborate.
    resultB = { ...skipped(extractorB, "not run — extractor A produced no gate-passing claim"), byDesign: true };
  }

  const bDown = resultB.status === "provider_failure" || (resultB.status === "skipped" && !resultB.byDesign);

  // ---- verification mode --------------------------------------------------
  let mode;
  if (aDown && bDown) mode = VERIFICATION_MODE.NONE;
  else if (aDown) mode = VERIFICATION_MODE.GROQ_ONLY;
  else if (bDown) mode = VERIFICATION_MODE.GEMINI_ONLY;
  else mode = VERIFICATION_MODE.DUAL;

  const comparisons = neededPins.map((pin) => comparePin(pin, resultA, resultB, mode));

  return {
    partNumber,
    package: pkg,
    verification_mode: mode,
    degraded: isDegraded(mode),
    degradedWarning: isDegraded(mode) ? DEGRADED_WARNING : null,
    extractorA: {
      name: extractorA.name,
      ok: resultA.ok,
      status: resultA.status,
      reason: resultA.reason,
      servedBy: resultA.servedBy ?? null,
      tiersTried: resultA.tiersTried ?? null,
    },
    extractorB: {
      name: extractorB.name,
      ok: resultB.ok,
      status: resultB.status,
      reason: resultB.reason,
      servedBy: resultB.servedBy ?? null,
      tiersTried: resultB.tiersTried ?? null,
    },
    claimCounts: { A: resultA.claims.length, B: resultB.claims.length },
    // Which providers failed this part, so the caller can update health state.
    providerFailures: {
      A: resultA.status === "provider_failure" ? resultA.reason : null,
      B: resultB.status === "provider_failure" ? resultB.reason : null,
    },
    comparisons,
    autoAccepted: comparisons.filter((c) => c.outcome === OUTCOME.AUTO_ACCEPTED),
    needsReview: comparisons.filter((c) => c.outcome === OUTCOME.NEEDS_REVIEW),
    notFound: comparisons.filter((c) => c.outcome === OUTCOME.NOT_FOUND),
    notAttempted: comparisons.filter((c) => c.outcome === OUTCOME.NOT_ATTEMPTED),
  };
}

/** Back-compat alias: Extractor B used to be x.ai-specific. */
export const callGrok = callExtractorB;
