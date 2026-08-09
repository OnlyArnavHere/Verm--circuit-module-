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

export const OUTCOME = Object.freeze({
  AUTO_ACCEPTED: "auto_accepted", // both extractors agreed, both passed both gates
  NEEDS_REVIEW: "needs_review", // disagreement, or a gate failure on either side
  NOT_FOUND: "not_found", // no datasheet, or no extractor produced a claim
});

/** Default extractor pair. `datasheetText` is filled in per call. */
export const defaultExtractors = () => {
  const provider = detectProvider(extractorBKey());
  return [
    { id: "A", name: "gemini", model: "gemini-flash-latest", call: callGemini },
    {
      id: "B",
      name: provider?.name ?? "extractor-b(unconfigured)",
      model: provider?.defaultModel,
      call: callExtractorB,
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
    return { id: extractor.id, name: extractor.name, ok: false, reason: response.reason, claims: [] };
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

  return { id: extractor.id, name: extractor.name, ok: true, claims };
}

const findClaim = (result, logicalPin) =>
  result.claims.find((claim) => claim.logical_pin === logicalPin) ?? null;

/**
 * Compare two independent extractions for one logical pin.
 * Auto-accept requires: both produced a claim, both passed BOTH gates, and both
 * landed on the same physical pin.
 */
export function comparePin(logicalPin, resultA, resultB) {
  const a = findClaim(resultA, logicalPin);
  const b = findClaim(resultB, logicalPin);

  const base = { logical_pin: logicalPin, a, b };

  if (!a && !b) {
    return { ...base, outcome: OUTCOME.NOT_FOUND, reason: "neither extractor returned this pin" };
  }
  if (!a || !b) {
    const which = a ? "B" : "A";
    return {
      ...base,
      outcome: OUTCOME.NEEDS_REVIEW,
      reason: `only one extractor returned this pin (extractor ${which} did not)`,
    };
  }
  if (!a.passed || !b.passed) {
    const failed = [!a.passed && "A", !b.passed && "B"].filter(Boolean).join(" and ");
    return {
      ...base,
      outcome: OUTCOME.NEEDS_REVIEW,
      reason: `extractor ${failed} failed a deterministic gate`,
    };
  }
  if (String(a.physical_pin).toUpperCase() !== String(b.physical_pin).toUpperCase()) {
    return {
      ...base,
      outcome: OUTCOME.NEEDS_REVIEW,
      reason:
        `independent extractions DISAGREE: A says ${a.physical_pin}, B says ${b.physical_pin}. ` +
        `Both passed both gates, so both excerpts are genuinely in the datasheet — ` +
        `a human must decide which reading is authoritative.`,
    };
  }

  return {
    ...base,
    outcome: OUTCOME.AUTO_ACCEPTED,
    physical_pin: a.physical_pin,
    reason: `both extractors independently extracted ${a.physical_pin}, both passed both gates`,
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
}) {
  const [extractorA, extractorB] = extractors;

  // Both extractors read the same reduced text (see selectPinSections). A
  // restricted-view test extractor supplies its own and is left untouched.
  const shared = selectPinSections(datasheetText, neededPins);

  const resultA = await runExtractor(extractorA, {
    partNumber,
    pkg,
    neededPins,
    datasheetText: extractorA.datasheetText ?? shared,
    footprintPads,
    padAliases,
    padVocabulary,
    fetchImpl,
  });

  // B runs only if A produced at least one gate-passing claim — no point paying
  // for a second extraction otherwise. B is never shown A's output.
  const anyPassed = resultA.ok && resultA.claims.some((claim) => claim.passed);
  const resultB = anyPassed
    ? await runExtractor(extractorB, {
        partNumber,
        pkg,
        neededPins,
        datasheetText: extractorB.datasheetText ?? shared,
        footprintPads,
        padAliases,
        padVocabulary,
        fetchImpl,
      })
    : { id: extractorB.id, name: extractorB.name, ok: false, reason: "not run — extractor A produced no gate-passing claim", claims: [] };

  const comparisons = neededPins.map((pin) => comparePin(pin, resultA, resultB));

  return {
    partNumber,
    package: pkg,
    extractorA: { name: extractorA.name, ok: resultA.ok, reason: resultA.reason },
    extractorB: { name: extractorB.name, ok: resultB.ok, reason: resultB.reason },
    comparisons,
    autoAccepted: comparisons.filter((c) => c.outcome === OUTCOME.AUTO_ACCEPTED),
    needsReview: comparisons.filter((c) => c.outcome === OUTCOME.NEEDS_REVIEW),
    notFound: comparisons.filter((c) => c.outcome === OUTCOME.NOT_FOUND),
  };
}

/** Back-compat alias: Extractor B used to be x.ai-specific. */
export const callGrok = callExtractorB;
