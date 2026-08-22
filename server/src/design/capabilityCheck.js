/**
 * Capability-mismatch detection (Phase 6.6).
 *
 * Distinguishes two things that `PIN_NOT_FOUND` was conflating:
 *
 *   PIN_NOT_FOUND            "we have not resolved this pin — it may well exist"
 *   PART_CAPABILITY_MISMATCH "we have positively confirmed this part's real pins,
 *                             and the requested function is not among them"
 *
 * The second is not a resolution gap at all — it is an upstream design error. No
 * amount of datasheet work will make an LED driver grow an audio pin. Reporting
 * it as `PIN_NOT_FOUND` sends someone to look for something that cannot be found.
 *
 * ── Two guards keep this from over-claiming ─────────────────────────────────
 *
 * 1. **Complete name coverage required.** A negative claim is only sound if we
 *    know *every* pad's name. Measured in distinct PADS named, not in name
 *    count: one pad can expose several aliases. `HDSP-521G` names 16 of 18 pads, and the two
 *    unnamed ones (pin13/pin14) are exactly where a DIP-18 display's common
 *    pins sit — so "it has no GND" would be a false positive. Partial coverage
 *    stays `PIN_NOT_FOUND`.
 *
 * 2. **Functional naming required.** `MIMXRT1172CVM8A` names all 289 pads — but
 *    by ball coordinate (`A1`, `T17`), not by function. Complete naming is not
 *    functional naming, and the absence of a pad literally called "GND" says
 *    nothing about whether the part has a ground. Detected by requiring at least
 *    one recognised supply-rail name: a functionally-named part essentially
 *    always names its own power pins.
 *
 * 3. **Programmable I/O exemption.** A function can be absent as a *named pin*
 *    yet available by mux assignment. `RF-BM-2340A2I` exposes `DIO3..DIO24` and
 *    no `TX` — but its UART is firmware-mapped onto a DIO, so the part plainly
 *    can do TX. That is a mux-table gap, not a missing capability. Only applies
 *    to functions that are actually mux-assignable: an antenna feed is not.
 */

/** Pin names that indicate general-purpose, mux-assignable I/O. */
const GENERIC_IO = /^(IO|DIO|GPIO|P[A-Z]?\d|PIO)\d*$/i;

/**
 * Logical functions that a generic I/O pin could plausibly be assigned to.
 * Physical/analog functions (an antenna feed, a supply rail) are NOT here —
 * those cannot be conjured onto a GPIO.
 */
const MUX_ASSIGNABLE = /^(SDA|SCL|MOSI|MISO|SCK|SS|CS|TX|RX|TXD|RXD|UART\w*|SPI\w*|I2C\w*|GPIO\d*|PWM\w*|INT\w*)$/i;

/**
 * A supply-rail name. Its presence is the signal that a part's pin names are
 * FUNCTIONAL rather than positional — a part that names its pads by function
 * names its power pins; one that names them `A1`/`T17` does not.
 */
const SUPPLY_RAIL = /^(VDD|VCC|VSS|GND|VBAT|VIN|AVDD|AVSS|DVDD|VDDA|VSSA|AGND|DGND)\d*$/i;

export const CAPABILITY_VERDICT = Object.freeze({
  MISMATCH: "PART_CAPABILITY_MISMATCH",
  UNRESOLVED: "PIN_NOT_FOUND",
});

/**
 * Decide how to report a logical pin that did not match any real pin name.
 *
 * @param {string} logicalPin the function the net asked for, e.g. "AUDIO"
 * @param {{ok: boolean, pins?: object, padCount?: number}} pinout resolved capability data
 * @returns {{code: string, reason: string, capabilityConfirmed: boolean, availablePins?: string[]}}
 */
export function classifyUnresolvedPin(logicalPin, pinout) {
  const wanted = String(logicalPin ?? "").trim();
  const names = pinout?.ok ? Object.keys(pinout.pins ?? {}) : [];
  const padCount = pinout?.padCount ?? 0;
  // COUNT PADS, NOT NAMES. `pins` maps NAME -> pad, and port_hints can give one
  // pad several aliases, so a part can carry MORE names than it has pads
  // (observed: jlcpcb:C22392413, 30 pads / 57 names). Comparing name count to
  // pad count could therefore satisfy the completeness guard while pads remain
  // unnamed — turning an unknown into a confident PART_CAPABILITY_MISMATCH,
  // which is the exact false claim this guard exists to prevent.
  const namedPads = new Set(Object.values(pinout?.pins ?? {})).size;

  // No capability data at all — nothing has been confirmed, so no negative claim.
  if (!pinout?.ok || names.length === 0 || padCount === 0) {
    return {
      code: CAPABILITY_VERDICT.UNRESOLVED,
      capabilityConfirmed: false,
      reason: "no confirmed capability data for this part; the pin may still exist",
    };
  }

  // Guard 1: partial coverage cannot support a negative claim.
  const coverage = namedPads / padCount;
  if (namedPads < padCount) {
    const unnamed = padCount - namedPads;
    return {
      code: CAPABILITY_VERDICT.UNRESOLVED,
      capabilityConfirmed: false,
      availablePins: names.sort(),
      reason:
        `only ${namedPads} of ${padCount} pads are named (${unnamed} unnamed), so the ` +
        `absence of "${wanted}" is not confirmed — it could be one of the unnamed pads`,
      coverage: Number(coverage.toFixed(2)),
    };
  }

  // Guard 2: complete but POSITIONAL naming supports no capability claim.
  const functionallyNamed = names.some((name) => SUPPLY_RAIL.test(name));
  if (!functionallyNamed) {
    return {
      code: CAPABILITY_VERDICT.UNRESOLVED,
      capabilityConfirmed: false,
      availablePins: names.slice(0, 12).sort(),
      reason:
        `this part's ${padCount} pads are named positionally (e.g. ` +
        `${names.slice(0, 3).join(", ")}) rather than by function — no supply-rail name ` +
        `is present, so the naming carries no capability information`,
    };
  }

  // Guard 3: a mux-assignable function on a part with generic I/O may exist
  // without a dedicated named pin.
  const hasGenericIo = names.some((name) => GENERIC_IO.test(name));
  if (hasGenericIo && MUX_ASSIGNABLE.test(wanted)) {
    return {
      code: CAPABILITY_VERDICT.UNRESOLVED,
      capabilityConfirmed: false,
      availablePins: names.sort(),
      reason:
        `"${wanted}" has no dedicated pin, but this part exposes general-purpose I/O ` +
        `(${names.filter((n) => GENERIC_IO.test(n)).slice(0, 4).join(", ")}…) that it may be ` +
        `mux-assigned to — a datasheet mux table is needed, not a capability claim`,
    };
  }

  // Every PAD is named, the function is not among them, and it is not something
  // a GPIO could be assigned to. The part genuinely does not do this.
  return {
    code: CAPABILITY_VERDICT.MISMATCH,
    capabilityConfirmed: true,
    availablePins: names.sort(),
    reason:
      `this part's complete pin set is confirmed (${padCount}/${padCount} pads named) and ` +
      `contains no "${wanted}". The part does not provide this function — no datasheet ` +
      `work can resolve it. This is an upstream net-assignment error.`,
  };
}

/** True when the part's capability set is complete enough to make negative claims. */
export const capabilityConfirmed = (pinout) =>
  Boolean(pinout?.ok) &&
  (pinout.padCount ?? 0) > 0 &&
  // Distinct PADS carrying a name, not name count — see classifyUnresolvedPin.
  new Set(Object.values(pinout.pins ?? {})).size === pinout.padCount;
