/**
 * Electrical / protocol validation of upstream nets.
 *
 * PROJECT_PLAN §1: "Treat the Hardware Agent's nets as claims to verify, not
 * ground truth." These checks target the four bugs found in the real fixture
 * data. Findings are reported — and where a correction is proposed, it is
 * recorded as a modification with the original value and a reason. Nothing is
 * silently rerouted (§5).
 *
 * Deliberately conservative: these flag structurally impossible wiring (a clock
 * pin tied to a data pin), not questionable-but-legal design choices.
 */

import { ALLOCATED_ROLES } from "./roleMap.js";

/** Pin-name roles used to detect incompatible pairings. */
const PIN_ROLE = [
  { role: "clock", match: /^(SCK|SCLK|CLK|SCL|CLOCK|BIT_CLOCK|WORD_CLOCK)$/i },
  { role: "data_out", match: /^(MOSI|SDO|TX|DOUT)$/i },
  { role: "data_in", match: /^(MISO|SDI|RX|DIN)$/i },
  { role: "bidir_data", match: /^(SDA|DATA)$/i },
  { role: "chip_select", match: /^(CS|SS|NSS|CHIP_SELECT)$/i },
];

/**
 * Schema 2.0 role -> the internal role vocabulary these checks reason about.
 * Kept explicit rather than reusing the regex table so that adding an upstream
 * role cannot silently fall through to "other" and disable a check.
 */
const V2_ROLE_TO_INTERNAL = Object.freeze({
  CLOCK: "clock",
  BIT_CLOCK: "clock",
  WORD_CLOCK: "clock",
  MOSI: "data_out",
  TX: "data_out",
  MISO: "data_in",
  RX: "data_in",
  DATA: "bidir_data",
  CHIP_SELECT: "chip_select",
  SUPPLY: "power",
  GROUND: "ground",
  GPIO: "other",
});

function roleOf(pin) {
  const found = PIN_ROLE.find((entry) => entry.match.test(String(pin)));
  return found?.role ?? "other";
}

/** Roles that must never share a net. */
const INCOMPATIBLE = [
  ["clock", "data_out"],
  ["clock", "data_in"],
  ["clock", "bidir_data"],
];

const parsePin = (ref) => {
  // v1: "U1.SDA". v2: "U1.I2C.CLOCK" or "U1.SPI.CHIP_SELECT@SPI_1_CS_U4".
  // The component is always the first field; the remainder identifies the pin.
  const [component, ...rest] = String(ref).split(".");
  return { component, pin: rest.join(".") || component };
};

/**
 * @param {object} upstream raw Hardware Agent payload
 * @returns {{errors: object[], modifications: object[]}}
 */
export function runElectricalChecks(upstream) {
  const errors = [];
  const modifications = [];
  const rawNets = upstream.nets ?? [];

  // Schema 2.0 declares a role per member, so these checks read the DECLARED
  // role instead of guessing one from a pin name. That is strictly stronger:
  // under v1 `roleOf("SDA")` is only as good as the (fabricated, D-076) name
  // upstream asserted, whereas a v2 role is what upstream actually meant.
  //
  // Most v2 documents cannot reach these errors at all -- a net carries one
  // role by construction, so a clock cannot be tied to a data pin. The checks
  // stay because a hand-written or third-party v2 document could still do it,
  // and silently trusting that is exactly what this project does not do.
  // A terminal must identify a PHYSICAL PIN, not just a role. Two things make
  // `ref_id.role` wrong on its own:
  //   * a role repeats across interfaces -- U1's I2C clock and U1's SPI clock are
  //     different pads that both stringify to "U1.CLOCK";
  //   * an ALLOCATED role repeats within one interface -- a controller has one
  //     chip-select pad PER peripheral, so two CS nets are two pins, not a
  //     split bus.
  // Both produced false INVALID_NET reports on the first real v2 capture before
  // the interface (and, for allocated roles, the net) was folded into the key.
  const terminalOf = (net, m) =>
    ALLOCATED_ROLES.has(m.role)
      ? `${m.ref_id}.${net.interface}.${m.role}@${net.name}`
      : `${m.ref_id}.${net.interface}.${m.role}`;

  const v2 = String(upstream.schema_version ?? "").startsWith("2.");
  const nets = v2
    ? rawNets.map((net) => ({
        ...net,
        connections: (net.members ?? []).map((m) => terminalOf(net, m)),
        _declaredRoles: Object.fromEntries(
          (net.members ?? []).map((m) => [
            terminalOf(net, m),
            V2_ROLE_TO_INTERNAL[m.role] ?? "other",
          ])
        ),
      }))
    : rawNets;

  // v1 infers a role from the asserted pin name; v2 uses what upstream declared.
  const roleFor = (net, terminal, pin) =>
    net._declaredRoles?.[terminal] ?? roleOf(pin);

  // --- 1. clock tied to data (the SCK<->MOSI bug) --------------------------
  for (const net of nets) {
    if (net.net_class !== "signal") continue;

    const members = (net.connections ?? []).map(parsePin);
    const roles = members.map((m) => ({
      ...m,
      role: roleFor(net, `${m.component}.${m.pin}`, m.pin),
    }));

    for (const [roleA, roleB] of INCOMPATIBLE) {
      const a = roles.find((r) => r.role === roleA);
      const b = roles.find((r) => r.role === roleB);
      if (!a || !b) continue;

      errors.push({
        code: "ELECTRICAL_CONFLICT",
        message:
          `Net "${net.name}" ties ${a.component}.${a.pin} (${roleA}) to ` +
          `${b.component}.${b.pin} (${roleB}). A clock line cannot drive a data pin — ` +
          `this net cannot work as wired.`,
        target: `nets.${net.name}`,
        detail: {
          net: net.name,
          connections: net.connections,
          conflict: [`${a.component}.${a.pin}`, `${b.component}.${b.pin}`],
          roles: [roleA, roleB],
        },
      });

      // Proposed correction is recorded, NOT applied — rerouting silently is
      // exactly what §5 forbids, and the right fix needs the real pinout.
      modifications.push({
        target: `nets.${net.name}`,
        field: "connections",
        originalValue: net.connections,
        correctedValue: null,
        reason:
          `Clock/data conflict: ${a.component}.${a.pin} (${roleA}) wired to ` +
          `${b.component}.${b.pin} (${roleB}). Correction NOT auto-applied — the ` +
          `likely intent is ${a.component}.${a.pin} -> ${b.component}.${a.pin}, but ` +
          `confirming that requires the verified pinout.`,
        detectedBy: "CLOCK_TIED_TO_DATA_PIN",
      });
    }
  }

  // --- 2. split bus half-nets ----------------------------------------------
  // Two nets that each terminate on the same controller pin but never join each
  // other's companion line: one bus modelled as two disconnected halves.
  const byTerminal = new Map(); // "U1.SDA" -> [net, ...]
  for (const net of nets) {
    if (net.net_class !== "signal") continue;
    for (const connection of net.connections ?? []) {
      if (!byTerminal.has(connection)) byTerminal.set(connection, []);
      byTerminal.get(connection).push(net);
    }
  }

  for (const [terminal, sharing] of byTerminal) {
    if (sharing.length < 2) continue;

    const { pin } = parsePin(terminal);
    const role = sharing[0]?._declaredRoles?.[terminal] ?? roleOf(pin);
    // Only meaningful for shared-bus signals; a GPIO fanning out is legitimate.
    if (role !== "bidir_data" && role !== "clock") continue;

    const netNames = sharing.map((n) => n.name).sort();
    errors.push({
      code: "INVALID_NET",
      message:
        `Nets ${netNames.join(" and ")} both terminate at ${terminal} but are not ` +
        `joined to each other. A shared bus modelled as disconnected half-nets — ` +
        `the peripherals cannot talk on the same bus as wired.`,
      target: terminal,
      detail: {
        terminal,
        nets: netNames,
        connections: sharing.map((n) => ({ name: n.name, connections: n.connections })),
      },
    });

    modifications.push({
      target: `nets.${netNames.join("+")}`,
      field: "connections",
      originalValue: sharing.map((n) => n.connections),
      correctedValue: null,
      reason:
        `${netNames.join(" and ")} share terminal ${terminal} and should be one bus. ` +
        `Merge NOT auto-applied — joining them also requires the companion line ` +
        `(e.g. SCL) to be wired, which the upstream data does not specify.`,
      detectedBy: "SPLIT_BUS_HALF_NETS",
    });
  }

  // --- 3. one pin appearing in multiple named nets --------------------------
  // `gas_leakage_detector.json` wires U1.GPIO1 into both GPIO_5 and GPIO_6.
  // A driver fanning out to several loads is legal — but expressing it as two
  // separately-named nets is not how a fan-out is modelled, and it is the same
  // shape as the split-bus bug. Reported distinctly from the bus case, because
  // the correct resolution differs: a bus should be merged, a fan-out should be
  // one net with three endpoints.
  for (const [terminal, sharing] of byTerminal) {
    if (sharing.length < 2) continue;

    const { pin } = parsePin(terminal);
    const role = sharing[0]?._declaredRoles?.[terminal] ?? roleOf(pin);
    // Bus roles are already covered by the split-bus check above.
    if (role === "bidir_data" || role === "clock") continue;

    const netNames = sharing.map((net) => net.name).sort();
    const allEndpoints = [
      ...new Set(sharing.flatMap((net) => net.connections ?? [])),
    ].sort();

    errors.push({
      code: "INVALID_NET",
      message:
        `Pin ${terminal} appears in ${sharing.length} separate nets ` +
        `(${netNames.join(", ")}). One pin cannot belong to two distinct nets — ` +
        `if it genuinely drives multiple loads, that is a single net with ` +
        `${allEndpoints.length} endpoints, not ${sharing.length} nets.`,
      target: terminal,
      detail: {
        terminal,
        nets: netNames,
        endpointsIfMerged: allEndpoints,
        connections: sharing.map((net) => ({
          name: net.name,
          connections: net.connections,
        })),
      },
    });

    modifications.push({
      target: `nets.${netNames.join("+")}`,
      field: "connections",
      originalValue: sharing.map((net) => net.connections),
      correctedValue: null,
      reason:
        `${netNames.join(" and ")} both include ${terminal}. If this is an ` +
        `intentional fan-out they should be one net with endpoints ` +
        `${allEndpoints.join(", ")}. Merge NOT auto-applied — whether these are ` +
        `one signal or two distinct signals sharing a pin by mistake is a design ` +
        `question the upstream data does not answer.`,
      detectedBy: "PIN_IN_MULTIPLE_NETS",
    });
  }

  // --- 4. degenerate nets ---------------------------------------------------
  for (const net of nets) {
    const count = (net.connections ?? []).length;
    if (count < 2) {
      errors.push({
        code: "INVALID_NET",
        message: `Net "${net.name}" has ${count} endpoint(s); a net needs at least 2.`,
        target: `nets.${net.name}`,
        detail: { connections: net.connections ?? [] },
      });
    }
  }

  return { errors, modifications };
}
