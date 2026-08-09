/**
 * Semantic target verification for modification requests (Phase 8).
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * DRC and geometric validation catch wrong COORDINATES. They cannot catch a
 * wrong TARGET: if "move the BLE module" resolves to the power regulator, the
 * regulator moves to a perfectly legal position and every geometric check
 * passes. The board is valid and wrong, and nothing downstream can tell.
 *
 * So this compares the words the user actually used against the resolved
 * component's real `part_class` / `part_number` — data already in hand, no new
 * extraction, no model call.
 *
 * ── Deliberately not a hard block ───────────────────────────────────────────
 * The check is a heuristic over English, so it will occasionally be wrong. It
 * is loud, not fatal: the user can simply ask again with a different target,
 * the same recoverability logic as the rest of Phase 8. What it must NOT do is
 * bury the warning somewhere only a person already suspicious would look.
 */

/**
 * Vocabulary → `part_class`. Terms are matched as whole words against the
 * request, so "led" does not fire inside "handled".
 */
const CLASS_TERMS = Object.freeze({
  communication: [
    "ble", "bluetooth", "wifi", "wi-fi", "radio", "antenna", "rf", "wireless",
    "transceiver", "comms", "communication", "zigbee", "lora", "esp",
  ],
  processing: [
    "mcu", "microcontroller", "micro", "processor", "cpu", "soc", "controller", "brain",
  ],
  sensor: [
    "sensor", "temperature", "temp", "humidity", "accelerometer", "gyro",
    "proximity", "pressure", "detector", "thermometer", "microphone", "mic",
  ],
  output: [
    "display", "screen", "led", "lcd", "oled", "segment", "driver", "buzzer",
    "speaker", "indicator", "output",
  ],
  power: [
    "power", "regulator", "charger", "charging", "battery", "supply", "ldo",
    "buck", "boost", "pmic", "protection",
  ],
  storage: ["memory", "flash", "storage", "eeprom", "ram", "rom"],
  clock: ["clock", "rtc", "crystal", "oscillator", "timer", "timing"],
  input: ["button", "switch", "keypad", "touch", "input", "encoder", "joystick"],
});

const words = (text) =>
  String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(Boolean);

/** Which part_classes the request's wording points at. */
export function inferReferencedClasses(request) {
  const tokens = new Set(words(request));
  const matched = new Map();

  for (const [partClass, terms] of Object.entries(CLASS_TERMS)) {
    const hits = terms.filter((term) => tokens.has(term));
    if (hits.length > 0) matched.set(partClass, hits);
  }
  return matched;
}

/** Explicit `U3`-style references — an exact ref_id leaves nothing to infer. */
export function explicitRefIds(request, knownRefIds = []) {
  const tokens = new Set(words(request).map((w) => w.toUpperCase()));
  return knownRefIds.filter((ref) => tokens.has(String(ref).toUpperCase()));
}

/** Explicit part-number references, e.g. "move the TP4110". */
export function explicitPartNumbers(request, components = []) {
  const haystack = String(request ?? "").toUpperCase();
  return components
    .filter((c) => c.part_number && haystack.includes(String(c.part_number).toUpperCase()))
    .map((c) => c.ref_id);
}

export const TARGET_VERDICT = Object.freeze({
  EXPLICIT: "explicit", // the user named the component directly
  CONSISTENT: "consistent", // wording agrees with the resolved part
  UNVERIFIABLE: "unverifiable", // no recognisable words to check against
  AMBIGUOUS: "ambiguous", // wording fits the target, but fits others equally
  MISMATCH: "mismatch", // wording clearly points at a different class
});

/**
 * Check the resolved target against what the request actually said.
 *
 * @param {string} request the raw natural-language request
 * @param {string} targetRefId the ref_id the interpreter chose
 * @param {Array<{ref_id: string, part_class: string, part_number: string}>} components
 */
export function verifyTarget(request, targetRefId, components = []) {
  const target = components.find((c) => c.ref_id === targetRefId);
  if (!target) {
    return {
      verdict: TARGET_VERDICT.MISMATCH,
      ok: false,
      message: `Target "${targetRefId}" is not a component in this design.`,
    };
  }

  const base = { targetRefId, targetClass: target.part_class, targetPart: target.part_number };

  // 1. The user named it outright — nothing to second-guess.
  const named = [
    ...explicitRefIds(request, components.map((c) => c.ref_id)),
    ...explicitPartNumbers(request, components),
  ];
  if (named.includes(targetRefId)) {
    return {
      ...base,
      verdict: TARGET_VERDICT.EXPLICIT,
      ok: true,
      message: `Request names ${targetRefId} explicitly.`,
    };
  }
  if (named.length > 0) {
    // They named something, and it wasn't this.
    return {
      ...base,
      verdict: TARGET_VERDICT.MISMATCH,
      ok: false,
      namedInstead: named,
      message:
        `The request appears to name ${named.join(", ")}, but the interpreter targeted ` +
        `${targetRefId} (${target.part_class}, ${target.part_number}).`,
    };
  }

  // 2. Infer from descriptive wording.
  const referenced = inferReferencedClasses(request);
  if (referenced.size === 0) {
    return {
      ...base,
      verdict: TARGET_VERDICT.UNVERIFIABLE,
      ok: true,
      message:
        `No recognisable component description in the request, so the target could not ` +
        `be cross-checked. Targeted ${targetRefId} (${target.part_class}).`,
    };
  }

  if (referenced.has(target.part_class)) {
    // Consistent — but flag if the description fits several components equally,
    // since then "correct class" does not mean "the one they meant".
    const sameClass = components.filter((c) => c.part_class === target.part_class);
    if (sameClass.length > 1) {
      return {
        ...base,
        verdict: TARGET_VERDICT.AMBIGUOUS,
        ok: true,
        candidates: sameClass.map((c) => `${c.ref_id} (${c.part_number})`),
        message:
          `"${[...referenced.get(target.part_class)].join('", "')}" matches ${sameClass.length} ` +
          `components of class "${target.part_class}" — ${sameClass.map((c) => c.ref_id).join(", ")}. ` +
          `Targeted ${targetRefId}; confirm that is the one you meant.`,
      };
    }
    return {
      ...base,
      verdict: TARGET_VERDICT.CONSISTENT,
      ok: true,
      message:
        `Request wording ("${referenced.get(target.part_class).join('", "')}") matches ` +
        `${targetRefId}'s class "${target.part_class}".`,
    };
  }

  // 3. Clear mismatch: the wording points at classes the target is not.
  const expected = [...referenced.keys()];
  const better = components.filter((c) => expected.includes(c.part_class));
  const usedTerms = [...referenced.values()].flat();

  return {
    ...base,
    verdict: TARGET_VERDICT.MISMATCH,
    ok: false,
    expectedClasses: expected,
    candidates: better.map((c) => `${c.ref_id} (${c.part_class}, ${c.part_number})`),
    message:
      `The request says "${usedTerms.join('", "')}", which describes a ` +
      `${expected.join("/")} component — but the interpreter targeted ${targetRefId}, ` +
      `which is ${target.part_class} (${target.part_number})` +
      (better.length
        ? `. Did you mean ${better.map((c) => c.ref_id).join(" or ")}?`
        : `. No component of that class exists in this design.`),
  };
}
