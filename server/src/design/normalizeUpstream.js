/**
 * Collapse both upstream schema versions into ONE internal net shape.
 *
 * Without this, every downstream module (resolver, electrical checks,
 * validatedDesign, circuit diagram) would need its own v1/v2 branch, and the
 * two paths would drift apart. Instead there is exactly one branch -- here --
 * and everything below it sees the same structure.
 *
 * Internal shape:
 *
 *   {
 *     name, net_class,
 *     interface,                       // v2 only; null for v1
 *     schemaVersion,
 *     members: [{
 *       ref_id,
 *       role,                          // v2: declared upstream. v1: INFERRED
 *                                      //     from the asserted pin name, and
 *                                      //     therefore only as trustworthy as
 *                                      //     that name (D-076).
 *       logicalPin,                    // v1: the asserted name. v2: null.
 *       roleIsDeclared,                // true only when upstream actually said it
 *     }]
 *   }
 *
 * `roleIsDeclared` is the load-bearing field. It is what lets a check know
 * whether it is reasoning about something upstream stated (v2) or something we
 * reverse-engineered from a fabricated pin name (v1). Do not let the two blur:
 * a v1 role is evidence about a string, not about the part.
 */

/** Pin-name -> role inference, for v1 documents only. */
const V1_PIN_ROLE = [
  { role: "CLOCK", match: /^(SCK|SCLK|CLK|SCL)$/i },
  { role: "MOSI", match: /^(MOSI|SDO_OUT|DOUT)$/i },
  { role: "MISO", match: /^(MISO|SDI_IN|DIN)$/i },
  { role: "DATA", match: /^(SDA)$/i },
  { role: "CHIP_SELECT", match: /^(CS|SS|NSS)$/i },
  { role: "TX", match: /^(TX|TXD)$/i },
  { role: "RX", match: /^(RX|RXD)$/i },
  { role: "SUPPLY", match: /^(VDD|VCC|3V3|VBAT)\d*$/i },
  { role: "GROUND", match: /^(GND|VSS)\d*$/i },
  { role: "GPIO", match: /^(GPIO|IO|DIO|PIO)\d*$/i },
];

const inferRoleFromPin = (pin) =>
  V1_PIN_ROLE.find((entry) => entry.match.test(String(pin)))?.role ?? null;

export const isSchemaV2 = (payload) =>
  String(payload?.schema_version ?? "").startsWith("2.");

/**
 * @param {object} payload raw upstream document, either schema version
 * @returns {{schemaVersion: string, nets: object[], wirelessLinks: object[]}}
 */
export function normalizeUpstream(payload) {
  const schemaVersion = String(payload?.schema_version ?? "1.0");
  const v2 = isSchemaV2(payload);

  const nets = (payload?.nets ?? []).map((net) => {
    if (v2) {
      return {
        name: net.name,
        net_class: net.net_class,
        interface: net.interface ?? null,
        schemaVersion,
        members: (net.members ?? []).map((member) => ({
          ref_id: member.ref_id,
          role: member.role ?? null,
          logicalPin: null,
          roleIsDeclared: true,
        })),
      };
    }

    return {
      name: net.name,
      net_class: net.net_class,
      interface: null,
      schemaVersion,
      members: (net.connections ?? []).map((connection) => {
        const [ref_id, logicalPin] = String(connection).split(".");
        return {
          ref_id,
          role: inferRoleFromPin(logicalPin),
          logicalPin,
          roleIsDeclared: false,
        };
      }),
    };
  });

  return {
    schemaVersion,
    nets,
    // v2 records wireless links separately: they are not board nets. v1 invented
    // an "ANT" pin on both endpoints instead, which is a trace that does not
    // physically exist.
    wirelessLinks: payload?.wireless_links ?? [],
  };
}

/**
 * What each component needs resolved, derived from normalized nets.
 *
 * v2 entries carry {interface, role} for role-based resolution; v1 entries carry
 * the asserted {logicalPin} for name matching. Replaces v1-only
 * `logicalPinsByRef`, which could only ever speak in pin names.
 *
 * @returns {Record<string, Array<{interface: string|null, role: string|null, logicalPin: string|null, net: string, roleIsDeclared: boolean}>>}
 */
export function pinRequestsByRef(nets) {
  const byRef = {};
  for (const net of nets ?? []) {
    for (const member of net.members ?? []) {
      if (!member.ref_id) continue;
      (byRef[member.ref_id] ??= []).push({
        interface: net.interface,
        role: member.role,
        logicalPin: member.logicalPin,
        net: net.name,
        roleIsDeclared: member.roleIsDeclared,
      });
    }
  }
  // Stable ordering so resolution and GPIO allocation are deterministic.
  for (const ref of Object.keys(byRef)) {
    byRef[ref].sort(
      (a, b) =>
        String(a.interface ?? "").localeCompare(String(b.interface ?? "")) ||
        String(a.role ?? "").localeCompare(String(b.role ?? "")) ||
        String(a.logicalPin ?? "").localeCompare(String(b.logicalPin ?? "")) ||
        String(a.net ?? "").localeCompare(String(b.net ?? ""))
    );
  }
  return byRef;
}
