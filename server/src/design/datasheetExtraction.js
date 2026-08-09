/**
 * LLM-assisted datasheet pin extraction — pilot (PROJECT_PLAN Phase 6/6c).
 *
 * Gemini acts as a **researcher, never an authority**. It reads a datasheet we
 * already fetched and proposes pin mappings; two deterministic gates decide
 * whether a proposal is even eligible for a human to confirm.
 *
 *   fetch datasheet ──(fails)──▶ PIN_NOT_FOUND, no model call
 *          │
 *          ▼
 *      Gemini proposes {logical_pin, physical_pin, evidence}
 *          │
 *          ├─ Gate 1 (structural): physical_pin must exist in the compiled
 *          │                       footprint's real pad list
 *          ├─ Gate 2 (anti-hallucination): evidence must fuzzy-match actual
 *          │                       datasheet text, checked in code
 *          ▼
 *      status "proposed"  ──(human confirms)──▶ eligible for curatedPinouts
 *
 * Rules this file exists to enforce:
 * - No datasheet in hand => no model call at all.
 * - A self-reported `confidence` is informational; it is NEVER a gate.
 * - Passing both gates does NOT make a mapping trusted — a human must confirm.
 * - Gemini runs only at cache-population time, never in the compile path, so
 *   the determinism guarantee is untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXTRACTION_CACHE_PATH = path.resolve(
  here,
  "../../data/datasheet-extraction-cache.json"
);

export const EXTRACTION_STATUS = Object.freeze({
  PROPOSED: "proposed", // passed both gates, awaiting human confirmation
  REJECTED: "rejected", // failed a gate — never eligible
  VERIFIED: "verified", // a human confirmed it against the real datasheet
});

// ---------------------------------------------------------------------------
// Datasheet acquisition
// ---------------------------------------------------------------------------

/** JLCPCB part-detail page for an LCSC code. */
export const partDetailUrl = (partNumber, lcsc) =>
  `https://jlcpcb.com/partdetail/${String(lcsc).replace(/^C/, "")}-${partNumber}/${lcsc}`;

/** A real browser UA — both sources reject obviously-scripted clients. */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** LCSC product-detail page for an LCSC code. */
export const lcscProductUrl = (lcsc) => `https://www.lcsc.com/product-detail/${lcsc}.html`;

/**
 * Pull candidate datasheet PDF links out of a part-detail page.
 *
 * Handles both sources:
 * - **LCSC** (`datasheet.lcsc.com/datasheet/pdf/<hash>.pdf`) — unsigned and
 *   stable, so it is preferred.
 * - **JLCPCB** (`…/smtDataManualFile/…`) — signed OSS URLs carrying a
 *   session-bound token. Measured: these return `403 SignatureDoesNotMatch` to a
 *   scripted client even with cookies and a matching Referer, so they are a
 *   fallback only.
 *
 * `www.lcsc.com/datasheet/<code>.pdf` looks like the obvious shortcut but serves
 * an HTML interstitial, not a PDF — deliberately not used.
 */
export function extractDatasheetUrls(html) {
  const normalized = String(html ?? "").replace(/\\u0026/g, "&").replace(/\\\//g, "/");

  const lcsc = normalized.match(/https:\/\/datasheet\.lcsc\.com\/[^"'\\ ,]*\.pdf[^"'\\ ,]*/g) ?? [];
  const jlc = (normalized.match(/https:\/\/[^"'\\ ,]*smtDataManualFile[^"'\\ ,]*/g) ?? []).filter(
    (url) => /\.pdf/i.test(url)
  );

  // Manufacturer-hosted PDFs linked from the LCSC page. Larger parts (the NXP
  // i.MX RT1170 BGA, the FS32K MCU) have no LCSC-hosted copy at all — LCSC links
  // straight to nxp.com. Without this the two hardest parts silently reported
  // "no datasheet". Site boilerplate (ISO certificates and the like) is excluded
  // so it can never be mistaken for a datasheet.
  const BOILERPLATE = /(iso[-_ ]?9001|iso-iec|certificat|quality|policy|brochure|catalog)/i;
  const external = (normalized.match(/https?:\/\/[^"'\\ ,)]+\.pdf[^"'\\ ,)]*/gi) ?? []).filter(
    (url) =>
      !BOILERPLATE.test(url) &&
      !/datasheet\.lcsc\.com/.test(url) &&
      !/smtDataManualFile/.test(url) &&
      !/assets\.lcsc\.com|static\.lcsc\.com/.test(url)
  );

  // LCSC first (stable), then signed JLCPCB links, then unsigned, then the
  // manufacturer's own copy.
  const ordered = [
    ...lcsc,
    ...jlc.filter((url) => /x-oss-signature=/.test(url)),
    ...jlc.filter((url) => !/x-oss-signature=/.test(url)),
    ...external,
  ];
  return [...new Set(ordered)];
}

/** Extract plain text from a PDF buffer. */
export async function pdfToText(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  }).promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).join(" "));
  }
  return pages.join("\n");
}

/**
 * Fetch a datasheet for an LCSC part.
 * @returns {Promise<{ok: true, url: string, text: string, bytes: number}
 *                  |{ok: false, code: "PIN_NOT_FOUND", reason: string, stage: string}>}
 */
export async function fetchDatasheet(
  partNumber,
  lcsc,
  { fetchImpl = fetch, pdfToTextImpl = pdfToText } = {}
) {
  // Two independent sources. LCSC first: its links are unsigned and stable,
  // whereas JLCPCB's are session-bound signed OSS URLs that 403 for a scripted
  // client. Both are tried before giving up.
  const sources = [
    { name: "lcsc", url: lcscProductUrl(lcsc), referer: "https://www.lcsc.com/" },
    { name: "jlcpcb", url: partDetailUrl(partNumber, lcsc), referer: "https://jlcpcb.com/" },
  ];

  const attempts = [];
  const candidates = [];

  for (const source of sources) {
    try {
      const response = await fetchImpl(source.url, {
        headers: { "user-agent": BROWSER_UA, referer: source.referer },
      });
      if (!response.ok) {
        attempts.push(`${source.name}: page HTTP ${response.status}`);
        continue;
      }
      const found = extractDatasheetUrls(await response.text());
      attempts.push(`${source.name}: ${found.length} link(s)`);
      candidates.push(...found.map((url) => ({ url, referer: source.referer })));
    } catch (error) {
      attempts.push(`${source.name}: ${error.message}`);
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      code: "PIN_NOT_FOUND",
      stage: "datasheet_link",
      reason: `no datasheet link found (${attempts.join("; ")})`,
    };
  }

  for (const { url, referer } of candidates) {
    try {
      const response = await fetchImpl(url, {
        headers: { "user-agent": BROWSER_UA, referer },
      });
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      // Guard against an XML error body being mistaken for a PDF.
      if (buffer.subarray(0, 4).toString("ascii") !== "%PDF") continue;

      const text = await pdfToTextImpl(buffer);
      if (!text.trim()) continue;
      return { ok: true, url, text, bytes: buffer.length };
    } catch {
      // Try the next candidate.
    }
  }

  return {
    ok: false,
    code: "PIN_NOT_FOUND",
    stage: "datasheet_download",
    reason:
      `all ${candidates.length} datasheet link(s) failed to download as a readable PDF ` +
      `(${attempts.join("; ")})`,
  };
}

// ---------------------------------------------------------------------------
// Gate 1 — structural
// ---------------------------------------------------------------------------

/**
 * The claimed physical pin must exist on the footprint that will actually be
 * compiled. Same discipline as assertPadIntegrity: a claim is checked against
 * real geometry, not accepted on assertion.
 */
/**
 * Normalize a claimed pin reference to the footprint's own pad vocabulary.
 *
 * Models write the same pin as `"pin2"`, `"2"`, `"Pin 2"`, or `"PIN2"`. Matching
 * the raw string rejected correct answers on formatting alone — a false negative
 * that makes the gate look strict while actually being wrong. Normalization is
 * purely syntactic: a bare number N resolves to `pinN` **only if that pad
 * exists**. Nothing is invented, and BGA-style ball ids (`A1`, `B14`) are left
 * untouched because they are already literal pad names. (D-045)
 */
export function normalizePinRef(claimed, footprintPads, padAliases = null) {
  const pads = footprintPads ?? [];
  const byUpper = new Map(pads.map((pad) => [String(pad).toUpperCase(), String(pad)]));
  const raw = String(claimed ?? "").trim();
  if (!raw) return null;

  const direct = byUpper.get(raw.toUpperCase());
  if (direct) return direct;

  // "Pin 2" / "PIN2" / "pin_2" -> "2"; a bare "2" stays "2".
  const numeric = raw.replace(/^pin[\s_-]*/i, "").trim();
  if (/^\d+$/.test(numeric)) {
    const candidate = byUpper.get(`PIN${numeric}`);
    if (candidate) return candidate;
  }

  // Datasheets name BGA balls ("J14") and often functional pins ("VSS1") where
  // the footprint's pads are "pinN". `padAliases` maps the part's real pin names
  // to pads, so a legitimate ball reference resolves instead of being rejected
  // as nonexistent. Still never invents: the alias must exist on this part.
  if (padAliases) {
    const aliasUpper = new Map(
      Object.entries(padAliases).map(([name, pad]) => [String(name).toUpperCase(), pad])
    );
    const viaAlias = aliasUpper.get(raw.toUpperCase());
    if (viaAlias && byUpper.has(String(viaAlias).toUpperCase())) {
      return byUpper.get(String(viaAlias).toUpperCase());
    }
  }
  return null;
}

export function gateStructural(claim, footprintPads, padAliases = null) {
  const pads = footprintPads ?? [];
  const raw = String(claim?.physical_pin ?? "").trim();

  if (!raw) {
    return { pass: false, reason: "no physical_pin in the extraction" };
  }

  const normalized = normalizePinRef(raw, pads, padAliases);
  if (!normalized) {
    return {
      pass: false,
      reason:
        `claimed physical pin "${claim.physical_pin}" does not exist on the compiled ` +
        `footprint (${pads.length} pads available)`,
    };
  }

  return {
    pass: true,
    normalizedPin: normalized,
    reason:
      normalized === raw
        ? `"${raw}" exists on the compiled footprint`
        : `"${raw}" normalized to "${normalized}", which exists on the compiled footprint`,
  };
}

// ---------------------------------------------------------------------------
// Gate 2 — anti-hallucination
// ---------------------------------------------------------------------------

const normalize = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[‐-―]/g, "-") // unicode dashes
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const tokens = (text) => normalize(text).split(" ").filter(Boolean);

/**
 * The evidence excerpt must actually appear in the datasheet.
 *
 * Checked **in code**, never by asking the model to grade itself. Exact
 * normalized substring passes outright; otherwise the best sliding window of
 * datasheet tokens must contain at least `threshold` of the evidence's tokens,
 * which tolerates PDF extraction artefacts (column bleed, spacing) without
 * tolerating invention.
 */
export function gateEvidence(claim, datasheetText, { threshold = 0.8 } = {}) {
  const evidence = String(claim?.evidence ?? "");
  if (evidence.trim().length < 8) {
    return { pass: false, score: 0, reason: "evidence excerpt missing or too short to verify" };
  }

  const haystack = normalize(datasheetText);
  const needle = normalize(evidence);

  if (haystack.includes(needle)) {
    return { pass: true, score: 1, reason: "evidence appears verbatim in the datasheet text" };
  }

  const needleTokens = tokens(evidence);
  const hayTokens = tokens(datasheetText);
  if (needleTokens.length === 0 || hayTokens.length === 0) {
    return { pass: false, score: 0, reason: "no comparable text" };
  }

  // Best containment over a sliding window the size of the evidence.
  const windowSize = needleTokens.length;
  const wanted = new Set(needleTokens);
  let best = 0;

  for (let start = 0; start + 1 <= hayTokens.length; start += 1) {
    const window = new Set(hayTokens.slice(start, start + windowSize));
    let hits = 0;
    for (const token of wanted) if (window.has(token)) hits += 1;
    const score = hits / wanted.size;
    if (score > best) best = score;
    if (best === 1) break;
  }

  return {
    pass: best >= threshold,
    score: Number(best.toFixed(3)),
    reason:
      best >= threshold
        ? `evidence matches datasheet text (${(best * 100).toFixed(0)}% token containment)`
        : `evidence does not appear in the datasheet (best match ${(best * 100).toFixed(0)}%, ` +
          `threshold ${(threshold * 100).toFixed(0)}%) — treated as hallucinated`,
  };
}

// ---------------------------------------------------------------------------
// Gate 3 — evidence relevance
// ---------------------------------------------------------------------------

/**
 * The evidence must actually mention the pin it claims.
 *
 * ── Why this exists (found by the batch, not by design) ─────────────────────
 * On TP4110, both extractors independently answered `VDD -> pin16` and both
 * passed gates 1 and 2 — but their reasons differed in kind:
 *   A: "16   VIN   外部电源输入端"        <- a pin-table row. Establishes pin 16.
 *   B: "VDD 充电输入电压 4.5~5.5 V"       <- an electrical-characteristics row.
 *                                           `VDD` here is a PARAMETER SYMBOL,
 *                                           not a pin. Establishes no pin.
 * Both excerpts are genuinely in the datasheet, so gate 2 passed both. The
 * comparator saw agreement on the answer and would have auto-accepted.
 *
 * Agreement on a conclusion is not agreement on a fact. This gate requires the
 * excerpt to contain the claimed pin identifier, so an excerpt that cannot
 * possibly support the claim is rejected regardless of how plausible it reads.
 */
export function gateEvidenceMentionsPin(claim, footprintPads, padAliases = null) {
  const evidence = String(claim?.evidence ?? "");
  const raw = String(claim?.physical_pin ?? "").trim();
  if (!evidence || !raw) {
    return { pass: false, reason: "no evidence or no claimed pin" };
  }

  const normalized = normalizePinRef(raw, footprintPads, padAliases);
  const candidates = new Set([raw.toUpperCase()]);
  if (normalized) {
    candidates.add(String(normalized).toUpperCase());
    const bare = String(normalized).replace(/^pin/i, "");
    if (bare) candidates.add(bare.toUpperCase());
  }
  // The alias the pad is known by on this part (a BGA ball id, or a pin name).
  if (padAliases) {
    for (const [name, pad] of Object.entries(padAliases)) {
      if (String(pad).toUpperCase() === String(normalized).toUpperCase()) {
        candidates.add(String(name).toUpperCase());
      }
    }
  }

  const haystack = evidence.toUpperCase();
  for (const candidate of candidates) {
    if (!candidate) continue;
    // Whole-token match. Boundaries exclude "." as well as digits, so a bare
    // "5" is NOT satisfied by the decimals in "4.5~5.5 V" — a voltage range must
    // never be read as a pin number.
    const pattern = new RegExp(
      `(^|[^0-9A-Z.])${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^0-9A-Z.]|$)`
    );
    if (pattern.test(haystack)) {
      return { pass: true, reason: `evidence mentions "${candidate}"` };
    }
  }

  return {
    pass: false,
    reason:
      `evidence does not mention pin "${raw}" — the excerpt cannot support the claim ` +
      `(it may be a parameter symbol or unrelated text that merely contains the pin name)`,
  };
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/**
 * Reduce a datasheet to the sections that could plausibly define a pin.
 *
 * Two reasons, and the second is the binding one:
 *  1. A 234,000-character MCU datasheet is mostly electrical characteristics,
 *     package drawings and ordering info — noise for this task.
 *  2. Extractor B (Groq free tier) caps at 12,000 tokens/minute. Full-text
 *     prompts returned HTTP 413 on every part above ~40K chars, so B silently
 *     never ran and every result looked like "B did not return this pin".
 *
 * Both extractors receive the IDENTICAL reduced text, so independence is
 * unaffected — they read the same source, just without the irrelevant bulk.
 * Gate 2 then checks evidence against this same text, so an excerpt from a
 * discarded section cannot pass.
 */
export function selectPinSections(datasheetText, neededPins = [], { maxChars = 24000, window = 2600 } = {}) {
  const text = String(datasheetText ?? "");
  if (text.length <= maxChars) return text;

  const anchors = [
    /pin\s*(description|configuration|function|assignment|definition)/gi,
    /(terminal|signal|ball)\s*(description|function|assignment|map)/gi,
    /pinout/gi,
    /package\s*(top\s*view|outline)/gi,
  ];
  // Also anchor on the pin names actually being looked for.
  for (const pin of neededPins) {
    if (/^[A-Za-z0-9_+-]{2,12}$/.test(pin)) {
      anchors.push(new RegExp(`\\b${pin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"));
    }
  }

  const ranges = [];
  for (const pattern of anchors) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      ranges.push([Math.max(0, match.index - window / 3), Math.min(text.length, match.index + window)]);
      if (ranges.length > 400) break;
    }
  }
  if (ranges.length === 0) return text.slice(0, maxChars);

  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (const [start, end] of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  let out = "";
  for (const [start, end] of merged) {
    if (out.length >= maxChars) break;
    out += `${text.slice(start, Math.min(end, start + (maxChars - out.length)))}\n...\n`;
  }
  return out;
}

export function buildPrompt({ partNumber, package: pkg, neededPins, datasheetText, footprintPads }) {
  // Stating the pad vocabulary removes a pure formatting failure ("5" vs "pin5")
  // without hinting at the answer — it says how to spell a pin, not which one.
  const padHint =
    footprintPads && footprintPads.length > 0 && footprintPads.length <= 64
      ? `Valid physical pin identifiers for this footprint are exactly: ${footprintPads.join(", ")}. Use one of these verbatim.`
      : `Identify the physical pin using the datasheet's own pin/ball identifier (e.g. "pin7" or "A1").`;

  return [
    `You are reading the datasheet for ${partNumber} (package ${pkg}).`,
    padHint,
    ``,
    `Identify the physical pin for ONLY these logical functions: ${neededPins.join(", ")}.`,
    `Do not return a full pinout. If a function is not present on this part, omit it.`,
    ``,
    `Return STRICT JSON only, no prose:`,
    `{"pins":[{"logical_pin":"GND","physical_pin":"pin4","evidence":"<near-verbatim excerpt from the datasheet>","confidence":0.0}]}`,
    ``,
    `The "evidence" field MUST be copied near-verbatim from the datasheet text below.`,
    `It is checked automatically against the source; paraphrase will be rejected.`,
    ``,
    `--- DATASHEET TEXT ---`,
    datasheetText,
  ].join("\n");
}

/** True when a real Gemini call is possible. */
export const geminiConfigured = () =>
  Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

export async function callGemini(
  prompt,
  {
    fetchImpl = fetch,
    // `gemini-flash-latest` rather than a pinned version: measured 2026-08-09,
    // gemini-2.0-flash returns 429 (quota) on this key and gemini-2.5-flash is
    // retired for new users.
    model = "gemini-flash-latest",
    // Injectable so the gates can be exercised without a live key. Production
    // always falls through to the environment.
    apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  } = {}
) {
  if (!apiKey) {
    return { ok: false, reason: "GEMINI_API_KEY is not set; no model call was made" };
  }

  try {
    const response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
      }
    );
    if (!response.ok) {
      return { ok: false, reason: `Gemini returned HTTP ${response.status}` };
    }
    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return { ok: true, raw: text, parsed: JSON.parse(text) };
  } catch (error) {
    return { ok: false, reason: `Gemini call failed: ${error.message}` };
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(EXTRACTION_CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(EXTRACTION_CACHE_PATH), { recursive: true });
  const sorted = Object.fromEntries(
    Object.entries(cache).sort(([a], [b]) => a.localeCompare(b))
  );
  fs.writeFileSync(EXTRACTION_CACHE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
}

/**
 * Run the full pilot for one part.
 *
 * @returns {Promise<{ok: boolean, code?: string, results?: object[], record?: object}>}
 */
export async function extractPinsFromDatasheet({
  partNumber,
  lcsc,
  package: pkg,
  neededPins,
  footprintPads,
  fetchImpl = fetch,
  pdfToTextImpl = pdfToText,
  apiKey,
  persist = true,
}) {
  // 1. Datasheet first. No datasheet => no model call, straight to PIN_NOT_FOUND.
  const datasheet = await fetchDatasheet(partNumber, lcsc, { fetchImpl, pdfToTextImpl });
  if (!datasheet.ok) {
    return {
      ok: false,
      code: "PIN_NOT_FOUND",
      geminiCalled: false,
      reason: `${datasheet.reason} (stage: ${datasheet.stage})`,
    };
  }

  // 2. Propose.
  const prompt = buildPrompt({ partNumber, package: pkg, neededPins, datasheetText: datasheet.text });
  const proposal = await callGemini(prompt, { fetchImpl, apiKey });
  if (!proposal.ok) {
    return { ok: false, code: "PIN_NOT_FOUND", geminiCalled: true, reason: proposal.reason };
  }

  // 3. Gate every claim independently.
  const results = (proposal.parsed?.pins ?? []).map((claim) => {
    const structural = gateStructural(claim, footprintPads);
    const evidence = gateEvidence(claim, datasheet.text);
    const passed = structural.pass && evidence.pass;

    return {
      logical_pin: claim.logical_pin,
      physical_pin: claim.physical_pin,
      evidence: claim.evidence,
      // Recorded for audit, explicitly NOT used as a gate.
      reportedConfidence: claim.confidence ?? null,
      gates: { structural, evidence },
      status: passed ? EXTRACTION_STATUS.PROPOSED : EXTRACTION_STATUS.REJECTED,
    };
  });

  const record = {
    partNumber,
    lcsc,
    package: pkg,
    neededPins,
    datasheetUrl: datasheet.url,
    datasheetBytes: datasheet.bytes,
    extractedAt: new Date().toISOString(),
    results,
    // Nothing is trusted until a human flips this.
    confirmedBy: null,
    confirmedAt: null,
  };

  if (persist) {
    const cache = loadCache();
    cache[`${partNumber}::${pkg}`] = record;
    saveCache(cache);
  }

  return { ok: true, geminiCalled: true, results, record };
}

/** Only human-confirmed records may be promoted into curatedPinouts.js. */
export function confirmedPins(partNumber, pkg) {
  const record = loadCache()[`${partNumber}::${pkg}`];
  if (!record?.confirmedBy) return { ok: false, reason: "not confirmed by a human" };
  const verified = (record.results ?? []).filter(
    (result) => result.status === EXTRACTION_STATUS.VERIFIED
  );
  if (verified.length === 0) return { ok: false, reason: "no verified pins in the record" };
  return {
    ok: true,
    pins: Object.fromEntries(verified.map((r) => [r.logical_pin, r.physical_pin])),
    confirmedBy: record.confirmedBy,
    datasheetUrl: record.datasheetUrl,
  };
}
