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

/** Pin-name roles used to detect incompatible pairings. */
const PIN_ROLE = [
  { role: "clock", match: /^(SCK|SCLK|CLK|SCL)$/i },
  { role: "data_out", match: /^(MOSI|SDO|TX|DOUT)$/i },
  { role: "data_in", match: /^(MISO|SDI|RX|DIN)$/i },
  { role: "bidir_data", match: /^(SDA)$/i },
  { role: "chip_select", match: /^(CS|SS|NSS)$/i },
];

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
  const [component, pin] = String(ref).split(".");
  return { component, pin };
};

/**
 * @param {object} upstream raw Hardware Agent payload
 * @returns {{errors: object[], modifications: object[]}}
 */
export function runElectricalChecks(upstream) {
  const errors = [];
  const modifications = [];
  const nets = upstream.nets ?? [];

  // --- 1. clock tied to data (the SCK<->MOSI bug) --------------------------
  for (const net of nets) {
    if (net.net_class !== "signal") continue;

    const members = (net.connections ?? []).map(parsePin);
    const roles = members.map((m) => ({ ...m, role: roleOf(m.pin) }));

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
    const role = roleOf(pin);
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
    const role = roleOf(pin);
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
