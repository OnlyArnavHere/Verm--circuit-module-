/**
 * ValidatedDesign + per-field resolution -> tscircuit source.
 *
 * Deterministic string generation: components sorted by ref_id, pins sorted by
 * name, nets sorted by name. No randomness, no timestamps.
 *
 * ── The mock that lives here ────────────────────────────────────────────────
 * Logical pin names (`U1.SDA`) are assigned to physical pads **positionally**,
 * because no verified pinout exists for these MPNs. That is a fabrication and is
 * labelled `pins.source = "mock"` by the resolver. It is what makes the compiled
 * board renderable but NOT manufacturable — the layout is real, the pin
 * assignment is not.
 */

/** Deterministic positional pin assignment for one component. */
export function assignPins(refId, nets) {
  const used = new Set();
  for (const net of nets) {
    for (const connection of net.connections ?? []) {
      const [ref, pin] = String(connection).split(".");
      if (ref === refId && pin) used.add(pin);
    }
  }
  // Sorted so the same design always produces the same pad assignment.
  return [...used].sort((a, b) => a.localeCompare(b));
}

const jsx = (value) => JSON.stringify(value);

/**
 * @param {object} upstream raw design (post net de-duplication)
 * @param {Array<object>} resolvedComponents from resolver.resolveComponents
 * @returns {{source: string, pinMaps: object}}
 */
export function generateTscircuitSource(upstream, resolvedComponents) {
  const byRef = new Map(resolvedComponents.map((c) => [c.ref_id, c]));
  const components = [...(upstream.components ?? [])].sort((a, b) =>
    a.ref_id.localeCompare(b.ref_id)
  );
  const nets = [...(upstream.nets ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  const outline = upstream.constraints?.board_outline ?? {};
  const width = outline.width_mm ?? 100;
  const height = outline.height_mm ?? 60;
  // Honour the upstream layer_count. Beyond respecting the constraint, the
  // autorouter needs inner layers to escape dense parts — on 2 layers it cannot
  // route out of a BGA and silently leaves connections unrouted.
  const layerCount = upstream.constraints?.layer_count ?? 2;

  const pinMaps = {};
  const lines = [];

  // Spread components across the board deterministically so the autorouter has
  // room; placement quality is not the point of the POC, reproducibility is.
  const perRow = Math.ceil(Math.sqrt(components.length));
  const stepX = width / (perRow + 1);
  const stepY = height / (Math.ceil(components.length / perRow) + 1);

  components.forEach((component, index) => {
    const resolved = byRef.get(component.ref_id);
    const footprint = resolved?.resolution.footprint.value;

    // A component whose footprint never resolved is omitted from the compile
    // rather than given an invented one.
    if (!footprint) return;

    // Prefer the resolver's real name->pad mapping; fall back to positional
    // assignment only for logical pins the part has no named pad for.
    const logical = assignPins(component.ref_id, nets);
    const realMap = resolved?.resolution.pins.value ?? {};

    const padFor = {};
    let nextPositional = 1;
    for (const pin of logical) {
      if (realMap[pin]) {
        padFor[pin] = realMap[pin];
      } else {
        // Positional fallback: skip pads already claimed by a real match.
        let candidate;
        do {
          candidate = `pin${nextPositional++}`;
        } while (Object.values(realMap).includes(candidate));
        padFor[pin] = candidate;
      }
    }
    pinMaps[component.ref_id] = padFor;

    const col = index % perRow;
    const row = Math.floor(index / perRow);
    const pcbX = Number((-width / 2 + stepX * (col + 1)).toFixed(3));
    const pcbY = Number((height / 2 - stepY * (row + 1)).toFixed(3));

    // Schematic placement is required as well as PCB placement: without schX/schY
    // the schematic ports get no coordinates and tscircuit silently *skips* the
    // traces that reference them ("does not have x/y coordinates"), leaving nets
    // unrouted while still reporting success.
    const schX = Number(((col - (perRow - 1) / 2) * 5).toFixed(3));
    const schY = Number((-(row * 5)).toFixed(3));

    // NOTE: `pinLabels` is deliberately NOT set. Setting it prevents tscircuit
    // from producing PCB traces at all — verified in isolation: identical boards
    // route fine without it and yield pcb_trace_missing_error for every
    // connection with it. Catalogue footprints already carry the real pin names,
    // so the schematic stays readable without it.
    lines.push(
      `    <chip name=${jsx(component.ref_id)} footprint=${jsx(footprint)} ` +
        `pcbX={${pcbX}} pcbY={${pcbY}} schX={${schX}} schY={${schY}} />`
    );
  });

  // Traces: chain each net's members pairwise, skipping pins we did not assign.
  for (const net of nets) {
    const members = (net.connections ?? [])
      .map((connection) => {
        const [ref, pin] = String(connection).split(".");
        return { ref, pin, pad: pinMaps[ref]?.[pin] };
      })
      .filter((m) => m.pad);

    for (let i = 0; i < members.length - 1; i++) {
      const a = members[i];
      const b = members[i + 1];
      lines.push(
        `    <trace name=${jsx(`${net.name}_${i}`)} ` +
          `from=${jsx(`.${a.ref} > .${a.pad}`)} to=${jsx(`.${b.ref} > .${b.pad}`)} />`
      );
    }
  }

  const source = `circuit.add(
  <board width="${width}mm" height="${height}mm" layers={${layerCount}}>
${lines.join("\n")}
  </board>
)`;

  return { source, pinMaps };
}
