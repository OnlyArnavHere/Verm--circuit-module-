/**
 * Natural language -> bounded structured instruction (Phase 8).
 *
 * The LLM's ONLY job here is to map a sentence onto the small schema in
 * modification.js. It cannot emit tscircuit code or final geometry because the
 * schema has no field that would carry either — for the qualitative modes it
 * names an edge or a direction, and the deterministic layer computes the
 * millimetres.
 *
 * Same discipline as Phase 6's extraction: the model proposes, deterministic
 * code disposes. Nothing here is trusted; `validateInstructionShape` and
 * `validateResolvedPlacement` run on everything that comes back.
 */
import { callGemini } from "./datasheetExtraction.js";
import { callExtractorB } from "./dualExtraction.js";
import { INSTRUCTION_TYPE, INSTRUCTION_VERSION } from "./modification.js";

export function buildInterpretationPrompt({ request, design }) {
  const components = (design.components ?? []).map(
    (c) => `${c.ref_id} (${c.part_class}, ${c.part_number})`
  );
  const outline = design.constraints?.board_outline ?? {};

  return [
    `Translate a PCB modification request into a strict JSON instruction.`,
    ``,
    `Board: ${outline.width_mm}mm x ${outline.height_mm}mm, origin at centre.`,
    `Components: ${components.join("; ")}`,
    ``,
    `The ONLY supported modification is repositioning ONE component.`,
    `Component swaps, net/wiring changes and board-size changes are NOT supported.`,
    ``,
    `Return json in exactly one of these two shapes.`,
    ``,
    `To reposition:`,
    `{"type":"REPOSITION_COMPONENT","target":{"ref_id":"U3"},`,
    ` "placement":{ ...one mode below... },`,
    ` "interpretation":{"original_request":"...","rationale":"...","confidence":0.9}}`,
    ``,
    `Placement modes — pick the one the request actually implies:`,
    `  {"mode":"edge","edge":"left|right|top|bottom","margin_mm":5}`,
    `      for "move it to/near the <edge>". Do NOT compute coordinates yourself.`,
    `  {"mode":"relative_to","ref_id":"U1","direction":"left|right|above|below","distance_mm":10}`,
    `      for "next to X", "away from X".`,
    `  {"mode":"delta","dx_mm":-5,"dy_mm":0}   for "move it 5mm left".`,
    `  {"mode":"absolute","x_mm":20,"y_mm":15}`,
    `      ONLY when the user stated explicit coordinates. Never invent coordinates`,
    `      for a vague request — use edge or relative_to instead.`,
    ``,
    `If the request is anything other than repositioning one component:`,
    `{"type":"UNSUPPORTED","requested_change_class":"component_swap|net_change|board_constraint|unclear",`,
    ` "reason":"...","interpretation":{"original_request":"..."}}`,
    ``,
    `Identify the target by what the user describes (e.g. "the BLE module" ->`,
    `the communication-class component). If no component clearly matches, return`,
    `UNSUPPORTED with requested_change_class "unclear".`,
    ``,
    `REQUEST: ${request}`,
  ].join("\n");
}

const parseLoose = (text) => {
  const raw = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
};

/**
 * Interpret one request.
 *
 * Deliberately single-extractor, unlike Phase 6's dual verification: a
 * misinterpretation here cannot silently produce a wrong board. It is caught by
 * deterministic validation, then by DRC, and the user sees the interpreted
 * instruction in the version record. The cost of being wrong is a rejected
 * modification, not an unmanufacturable artifact — so the extra call is not
 * warranted. Extractor B is used only as a fallback if the primary is down.
 */
export async function interpretRequest({ request, design, fetchImpl = fetch }) {
  const prompt = buildInterpretationPrompt({ request, design });

  let response = await callGemini(prompt, { fetchImpl });
  let interpretedBy = "gemini";
  if (!response.ok) {
    response = await callExtractorB(prompt, { fetchImpl });
    interpretedBy = "extractor-b";
  }
  if (!response.ok) {
    return {
      ok: false,
      errors: [
        {
          code: "UNSUPPORTED_COMPONENT",
          message: `Could not interpret the request — no interpreter available: ${response.reason}`,
          target: "request",
          detail: {},
        },
      ],
    };
  }

  const parsed = response.parsed ?? parseLoose(response.raw);
  if (!parsed?.type) {
    return {
      ok: false,
      errors: [
        {
          code: "UNSUPPORTED_COMPONENT",
          message: "Interpreter returned no usable instruction.",
          target: "request",
          detail: { raw: String(response.raw ?? "").slice(0, 200) },
        },
      ],
    };
  }

  return {
    ok: true,
    interpretedBy,
    instruction: {
      instruction_version: INSTRUCTION_VERSION,
      ...parsed,
      interpretation: {
        ...(parsed.interpretation ?? {}),
        original_request: request,
      },
    },
    isUnsupported: parsed.type === INSTRUCTION_TYPE.UNSUPPORTED,
  };
}
