/**
 * Interface role -> real pin name resolution (schema 2.0).
 *
 * This is the mirror image of the upstream table that D-076 condemned, and the
 * difference is the whole point. The old dunkai `_interface_pin_name` mapped an
 * interface to a pin name and ASSERTED it, without ever looking at the part:
 * I2C always became SCL/SDA, on a 289-ball BGA as readily as on a SOT-23-6.
 *
 * Here the direction is reversed. Upstream now states only intent -- "this
 * component is the CLOCK on an I2C bus" -- and this module resolves that intent
 * against the pin names the part ACTUALLY exposes, read out of the compiled
 * footprint by `extractPinout()`. A candidate that the part does not expose is
 * not used. There is no fallback, no closest match, and no placeholder: an
 * unresolvable role is an error, never a guess.
 *
 * Candidates are ordered; the first name the part actually exposes wins, so
 * resolution is deterministic for a given part.
 *
 * ── Deliberate exclusions (do not "helpfully" add these) ────────────────────
 * `VIN` is NOT a candidate for SUPPLY. On a charger or converter the input
 * supply is not the device's own logic rail -- `TP4110` exposes `VIN` and no
 * VDD, and PIN_NOT_FOUND is the correct answer there (D-032).
 * `VDDA`/`AGND`/`DGND`/`VSSA` are NOT candidates for SUPPLY/GROUND. They are
 * separate analog rails, not aliases; wiring a digital rail to one is an
 * electrical error that renders perfectly (D-032).
 * Rail synonym and numbered-variant handling (GND->VSS, GND->GND1) is NOT
 * duplicated here -- `matchLogicalPin()` in pinout.js already owns it, and this
 * module defers to it so there is one implementation of that rule.
 */

/** Role -> ordered candidate pin names, keyed by interface. */
const ROLE_CANDIDATES = Object.freeze({
  I2C: {
    CLOCK: ["SCL", "SCLK", "I2C_SCL"],
    DATA: ["SDA", "SDIO", "I2C_SDA"],
  },
  SPI: {
    CLOCK: ["SCK", "SCLK", "SPC", "CLK"],
    MOSI: ["MOSI", "SDI", "SI", "DIN", "PICO"],
    MISO: ["MISO", "SDO", "SO", "DOUT", "POCI"],
    CHIP_SELECT: ["CS", "NCS", "SS", "NSS", "CSB", "CE"],
  },
  UART: {
    TX: ["TX", "TXD", "SOUT", "UART_TX"],
    RX: ["RX", "RXD", "SIN", "UART_RX"],
  },
  USB: { DP: ["DP", "D+", "USB_DP"], DM: ["DM", "D-", "USB_DM"], VBUS: ["VBUS", "USB_VBUS"] },
  CAN: { CAN_H: ["CANH", "CAN_H"], CAN_L: ["CANL", "CAN_L"] },
  Ethernet: { TXP: ["TX+", "TXP"], TXN: ["TX-", "TXN"], RXP: ["RX+", "RXP"], RXN: ["RX-", "RXN"] },
  SDIO: { CLOCK: ["CLK", "SDIO_CLK"], CMD: ["CMD", "SDIO_CMD"], DATA: ["DAT0", "D0", "SDIO_D0"] },
  PCIe: { TXP: ["TXP"], TXN: ["TXN"], RXP: ["RXP"], RXN: ["RXN"], CLOCK: ["REFCLK", "CLK"] },
  I2S: {
    BIT_CLOCK: ["BCLK", "SCK", "BIT_CLK"],
    WORD_CLOCK: ["LRCLK", "WS", "LRCK"],
    DATA: ["SD", "SDATA", "DIN", "DOUT"],
  },
  Power: {
    // GND/VSS and VDD/VCC equivalence plus numbered variants are applied by
    // matchLogicalPin(); these are the entry names it starts from.
    SUPPLY: ["VDD", "VCC"],
    GROUND: ["GND", "VSS"],
  },
  Audio: { AUDIO: ["AUD", "AUDIO", "MIC", "SPK"] },
  ADC: { ANALOG_IN: ["AIN", "ADC", "AN"] },
  Analog: { ANALOG_IN: ["AIN", "ADC", "AN"] },
  PWM: { PWM: ["PWM"] },
  // GPIO is handled by allocation, not by name lookup -- see allocateGpio().
  GPIO: { GPIO: [] },
});

/** Generic, mux-assignable I/O pads, in the form parts actually name them. */
const GENERIC_IO = /^(IO|DIO|GPIO|PIO|P[A-Z]?)(\d+)$/i;

/**
 * Roles that may share one net despite differing. Everything else on a net must
 * carry the same role; a clock never shares a wire with a data line.
 */
const COMPLEMENTARY_ROLES = [new Set(["TX", "RX"])];

/**
 * Roles where each net gets its OWN pad on the part, rather than all nets
 * sharing one pad.
 *
 * The distinction is physical, not cosmetic. A controller has ONE `SCL` pad that
 * every I2C peripheral shares -- two nets touching it means a split bus, which
 * is an error. But it has a SEPARATE chip-select pad per peripheral, and a
 * separate pad per GPIO connection; two nets carrying that role are two
 * different pins and entirely correct.
 *
 * Consequences, both of which matter:
 *  - the resolver must hand out a DISTINCT pad per request for these roles,
 *    instead of returning the same first match every time;
 *  - the split-bus / pin-in-multiple-nets checks must not treat two nets sharing
 *    one of these roles on a part as the same terminal.
 */
export const ALLOCATED_ROLES = Object.freeze(new Set(["CHIP_SELECT", "GPIO"]));

/** Every role name this module knows, for validating upstream input. */
export const KNOWN_ROLES = Object.freeze(
  new Set(Object.values(ROLE_CANDIDATES).flatMap((roles) => Object.keys(roles)))
);

export const isKnownInterface = (iface) =>
  Object.prototype.hasOwnProperty.call(ROLE_CANDIDATES, iface);

export const rolesForInterface = (iface) => Object.keys(ROLE_CANDIDATES[iface] ?? {});

/** Ordered candidate pin names for one interface/role pair. */
export function candidatesFor(iface, role) {
  return ROLE_CANDIDATES[iface]?.[role] ?? null;
}

/**
 * True when the roles present on a single net can physically share one wire.
 * @param {string[]} roles
 */
export function rolesAreCompatible(roles) {
  const unique = new Set(roles.filter(Boolean));
  if (unique.size <= 1) return true;
  return COMPLEMENTARY_ROLES.some(
    (pair) => pair.size === unique.size && [...unique].every((r) => pair.has(r))
  );
}

/**
 * Deterministically allocate a general-purpose I/O pad for a GPIO role.
 *
 * A GPIO net needs a CHOICE, not a lookup -- upstream states only "these two are
 * connected by a GPIO", and the architecture layer carries no sub-requirement
 * (no PWM/interrupt/ADC qualifier exists on the edge, verified upstream), so
 * there is nothing finer to honour. The lowest-numbered unallocated pad is
 * taken, which makes repeat runs identical.
 *
 * This is an allocation DECISION, not a resolved fact, so the caller records it
 * as a modification with a reason. It is never silent.
 *
 * @param {object} pinout          resolved pinout for the part
 * @param {Set<string>} allocated  pad selectors already taken on this part
 * @returns {{ok: true, pad: string, matchedName: string}|{ok: false, message: string, availablePins: string[]}}
 */
export function allocateGpio(pinout, allocated = new Set()) {
  const pins = pinout?.pins ?? {};
  const generic = Object.keys(pins)
    .map((name) => ({ name, m: GENERIC_IO.exec(name) }))
    .filter((entry) => entry.m)
    .sort((a, b) => Number(a.m[2]) - Number(b.m[2]) || a.name.localeCompare(b.name));

  for (const { name } of generic) {
    if (!allocated.has(pins[name])) {
      return { ok: true, pad: pins[name], matchedName: name };
    }
  }

  return {
    ok: false,
    message: generic.length
      ? "every general-purpose I/O pad on this part is already allocated"
      : "this part exposes no general-purpose I/O pads to allocate a GPIO from",
    availablePins: Object.keys(pins).sort(),
  };
}

/**
 * Resolve one interface/role onto a real pad of a specific part.
 *
 * Name matching is delegated to `matchLogicalPin` so that rail equivalence and
 * numbered-variant rules live in exactly one place (pinout.js).
 *
 * @param {string} iface
 * @param {string} role
 * @param {object} pinout resolved pinout from extractPinout()
 * @param {(logical: string, pinout: object) => object} matchLogicalPin
 * @returns {{ok: true, pad: string, matchedName: string, via: string, candidate: string}
 *          |{ok: false, message: string, tried: string[], availablePins: string[]}}
 */
export function resolveRole(iface, role, pinout, matchLogicalPin, allocated = new Set()) {
  const candidates = candidatesFor(iface, role);
  const available = Object.keys(pinout?.pins ?? {}).sort();
  // For a per-net role (chip select), a pad already handed to another net is not
  // a valid answer here -- two peripherals must not share one CS pin.
  const mustBeDistinct = ALLOCATED_ROLES.has(role);

  if (candidates === null) {
    return {
      ok: false,
      message: `no candidate pin names defined for ${iface}/${role}`,
      tried: [],
      availablePins: available,
    };
  }

  for (const candidate of candidates) {
    const match = matchLogicalPin(candidate, pinout);
    if (match.ok && !(mustBeDistinct && allocated.has(match.pad))) {
      return { ...match, candidate };
    }
  }

  if (mustBeDistinct) {
    // Fall back to numbered siblings of the same function (CS0, CS1, ...), which
    // is how parts actually expose multiple chip selects.
    const pins = pinout?.pins ?? {};
    const siblings = Object.keys(pins)
      .filter((name) => candidates.some((c) => new RegExp(`^${c}\\d+$`, "i").test(name)))
      .sort();
    for (const name of siblings) {
      if (!allocated.has(pins[name])) {
        return { ok: true, pad: pins[name], matchedName: name, via: "numbered_sibling", candidate: name };
      }
    }
  }

  return {
    ok: false,
    message:
      `no pin on this part matches ${iface}/${role} ` +
      `(tried ${candidates.join(", ") || "no candidates"})`,
    tried: candidates,
    availablePins: available,
  };
}
