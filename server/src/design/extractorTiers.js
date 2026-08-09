/**
 * Credential tiers for the two extractors, with key-level rotation.
 *
 *   Extractor A (Gemini)     : GEMINI_API_KEY -> GEMINI_API_KEY_2
 *   Extractor B (non-Gemini) : Groq_API_KEY -> Groq_API_KEY_2 -> Ollama Cloud
 *
 * ── What rotation does and does NOT change ──────────────────────────────────
 * Rotation is a CREDENTIAL concern, not an evidence concern. Whichever key or
 * endpoint served a request, the gates and the auto-accept rule are identical,
 * and `verification_mode` is unaffected: A served by the second Gemini key is
 * still Extractor A, and the run is still DUAL. Only when an extractor has
 * exhausted every tier does provider-level failover / degraded mode apply.
 *
 * ── Why Ollama sits in Extractor B's chain ──────────────────────────────────
 * Independence from Extractor A is what auto-accept rests on, and Ollama Cloud
 * serves `gpt-oss`, a different model family from both Gemini and Llama. So it
 * can stand in for B without weakening the independence property.
 *
 * ── Ollama is HOSTED, not local (measured) ──────────────────────────────────
 * No `ollama` binary, no daemon, `localhost:11434` unreachable; `ollama.com`
 * answers with the key. It is therefore another rate-limited cloud tier, NOT an
 * unlimited local fallback — worth being explicit, because a local runtime would
 * have been a genuinely different kind of resilience.
 */
import { callGemini } from "./datasheetExtraction.js";

/** Models can wrap JSON in prose or code fences; parse leniently but strictly enough. */
export function parseJsonLoose(text) {
  const raw = String(text ?? "").trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    // Fall back to the outermost {...} block.
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1));
      } catch {
        /* give up below */
      }
    }
    return null;
  }
}

/** One OpenAI-compatible chat call. Groq and Ollama Cloud both speak this. */
async function callOpenAICompatible(prompt, { url, apiKey, model, fetchImpl = fetch, providerLabel }) {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          // Groq requires the word "json" present when json_object is requested;
          // harmless elsewhere. Provider plumbing only — the user prompt stays
          // byte-identical across extractors, so blindness is unaffected.
          { role: "system", content: "Respond with a single JSON object and nothing else." },
          { role: "user", content: prompt },
        ],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(90000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      let detail = body.slice(0, 160);
      try {
        const parsed = JSON.parse(body);
        detail = (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ?? detail;
      } catch {
        /* keep raw */
      }
      return {
        ok: false,
        status: response.status,
        reason: `${providerLabel} returned HTTP ${response.status}: ${detail}`,
      };
    }

    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content ?? "";
    const parsed = parseJsonLoose(text);
    if (!parsed) {
      return { ok: false, status: 0, reason: `${providerLabel} returned unparseable JSON` };
    }
    return { ok: true, raw: text, parsed };
  } catch (error) {
    return { ok: false, status: 0, reason: `${providerLabel} call failed: ${error.message}` };
  }
}

const env = (name) => {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
};

/**
 * Build the credential chains from the environment.
 * Order is deliberate: primary key first, secondary next, alternate provider last.
 */
export function buildExtractorTiers() {
  const geminiKeys = [env("GEMINI_API_KEY"), env("GEMINI_API_KEY_2")].filter(Boolean);

  const groqKeys = [
    env("GROQ_API_KEY"),
    env("Groq_API_KEY"),
    env("GROQ_API_KEY_2"),
    env("Groq_API_KEY_2"),
  ]
    // The variable has held an x.ai key before; the prefix is the real test.
    .filter((key) => key && key.startsWith("gsk_"));

  const ollamaKey = env("ollama_API_KEY") ?? env("OLLAMA_API_KEY");

  const A = geminiKeys.map((apiKey, index) => ({
    provider: "gemini",
    label: `gemini#${index + 1}`,
    model: "gemini-flash-latest",
    call: (prompt, options) => callGemini(prompt, { ...options, apiKey, model: "gemini-flash-latest" }),
  }));

  const B = [
    ...[...new Set(groqKeys)].map((apiKey, index) => ({
      provider: "groq",
      label: `groq#${index + 1}`,
      model: "llama-3.3-70b-versatile",
      call: (prompt, options) =>
        callOpenAICompatible(prompt, {
          ...options,
          url: "https://api.groq.com/openai/v1/chat/completions",
          apiKey,
          model: "llama-3.3-70b-versatile",
          providerLabel: "groq",
        }),
    })),
    ...(ollamaKey
      ? [
          {
            provider: "ollama",
            label: "ollama-cloud",
            model: "gpt-oss:20b",
            call: (prompt, options) =>
              callOpenAICompatible(prompt, {
                ...options,
                url: "https://ollama.com/v1/chat/completions",
                apiKey: ollamaKey,
                model: "gpt-oss:20b",
                providerLabel: "ollama",
              }),
          },
        ]
      : []),
  ];

  return { A, B };
}

/** A failure worth rotating away from: quota, rate limit, or payload/size limits. */
export function isRotatableFailure(result) {
  if (result?.quotaExhausted) return true;
  const status = result?.status;
  if (status === 429 || status === 413 || status === 402 || status === 503) return true;
  return /quota|rate.?limit|too large|exceeded|credits|insufficient/i.test(String(result?.reason ?? ""));
}

/**
 * Try each tier in order until one succeeds.
 *
 * @returns {Promise<object>} the successful response plus `servedBy`, or a
 *   failure carrying every tier's reason so the batch report can explain why an
 *   extractor is considered down.
 */
export async function callWithRotation(tiers, prompt, options = {}) {
  if (!tiers || tiers.length === 0) {
    return { ok: false, reason: "no credentials configured for this extractor", tiersTried: [] };
  }

  const tiersTried = [];
  for (const tier of tiers) {
    const result = await tier.call(prompt, options);
    tiersTried.push({ tier: tier.label, ok: result.ok, reason: result.reason ?? null });

    if (result.ok) {
      return { ...result, servedBy: tier.label, provider: tier.provider, tiersTried };
    }
    // A non-rotatable failure (bad request, unparseable output) is a property of
    // the request, not the credential — rotating would just repeat it.
    if (!isRotatableFailure(result)) {
      return { ...result, servedBy: null, tiersTried };
    }
  }

  return {
    ok: false,
    servedBy: null,
    tiersTried,
    reason:
      `all ${tiers.length} credential tier(s) exhausted: ` +
      tiersTried.map((t) => `${t.tier}: ${String(t.reason).slice(0, 60)}`).join(" | "),
  };
}
