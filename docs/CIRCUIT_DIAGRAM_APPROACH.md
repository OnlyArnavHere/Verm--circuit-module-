# Circuit Diagram Rendering — investigation and decision

**Date:** 2026-08-09
**Phase:** 3 (prerequisite, per PROJECT_PLAN.md §3)
**Decision:** Build a **deterministic symbol-based renderer** on top of the
`schematic-symbols` library — option 2. Graphviz was **not** used.

Required output #1 must "visually resemble an actual electronics circuit
(recognizable component symbols/icons and wire-style connections)" and be
**distinct** from output #2, the formal schematic. This documents how that was
settled.

---

## Option 1 — Does tscircuit itself offer a circuit-diagram-style view?

**Investigated, and rejected — but not on the basis of the Phase 2 finding.**
Phase 2 only established that `convertCircuitJsonToSchematicSvg` produces a
formal schematic. This pass examined the whole renderer surface.

`circuit-to-svg@0.0.400` exports these view renderers:

| Export | What it produces | Circuit-diagram-like? |
|---|---|---|
| `convertCircuitJsonToSchematicSvg` | Formal schematic — every pin, pin numbers, net labels | No — this **is** output #2 |
| `convertCircuitJsonToPcbSvg` | Copper/PCB view | No |
| `convertCircuitJsonToAssemblySvg` | Physical placement, component outlines + refs | **No — rendered and checked: no connections drawn at all** |
| `convertCircuitJsonToPinoutSvg` | Pinout of a single chip | No |
| `convertCircuitJsonToStackedSchematicSheetsSvg` | Multi-sheet schematic | No — same renderer |
| `convertCircuitJsonToSchematicSimulationSvg` / `...SimulationGraphSvg` | Simulation waveforms | No |

I rendered the assembly view to be sure rather than judging by name
(`spikes/phase2-tscircuit/out/assembly.png`): it draws component outlines and
reference designators on a board outline with **zero connectivity**. It is a
placement drawing, not a circuit diagram.

I also searched the renderer for a decluttering/simplified mode. The only options
the schematic renderer accepts are `grid`, `labeled`, and `shouldDrawErrors` —
there is no "hide pin numbers", "symbol only", or "simplified" switch.

tscircuit does expose `schPinArrangement` / `schPinStyles` / `schWidth`
([docs](https://docs.tscircuit.com/guides/tscircuit-essentials/configuring-chips))
for controlling how a chip's pins are laid out. These are real decluttering knobs,
but they tune the **schematic** renderer — the output remains the formal schematic,
which is precisely the artifact output #1 must be distinct from.

**Verdict: nothing in the tscircuit ecosystem produces a separate
circuit-diagram-style view.**

## Option 2 — Another deterministic renderer — **CHOSEN**

The decisive find: `schematic-symbols@0.0.238` (already in the dependency tree,
and the library tscircuit's own renderer draws from) ships **351 real EE
symbols** — `ground_*`, `vcc_*`, `rail_*`, `crystal_*`, `led_*`, `battery_*`,
`opamp_*`, `resistor_*`, transistors, diodes, switches, and more.

Each symbol is plain vector data — primitives (`path`/`circle`/`text`) plus named
`ports` and a `size` — so it can be scaled, placed, and wired on our own canvas
with no tscircuit renderer involvement:

```js
symbols.ground_down.primitives // [{type:"path", points:[{x,y}...], fill:false}, ...]
symbols.ground_down.ports      // [{x:0.01, y:0.29, labels:["1"]}]
```

That makes a genuinely circuit-like drawing achievable **deterministically**,
without a layout solver and without inventing our own shapes for the parts that
have standard symbols.

### What makes it a circuit diagram rather than a schematic

The distinction is not decoration — it is *what gets omitted*:

| | Schematic (output #2, tscircuit) | Circuit diagram (output #1, ours) |
|---|---|---|
| Pins shown | **All** of them (U2 shows all 48) | **Only pins that participate in a net** |
| Pin numbers | Yes | No — signal names only (`SDA`, `SCK`) |
| Ground | A net like any other | **Ground symbols** at each termination |
| Power | N pairwise nets | One labelled **`+3V3` rail** with drops |
| Connections | Formal wires + net labels | Orthogonal **wire-style** runs, junction dots |
| Audience | An EE verifying the design | Anyone understanding the design |

Our fixtures are entirely ICs (`U1`–`U8`), and a labelled IC block with a pin-1
notch **is** the conventional circuit-diagram representation for an IC — so blocks
plus real ground/VCC glyphs is the correct idiom here, not a compromise. A
`part_class` tag (`MCU`, `SENSOR`, `PWR`, `COMM`, `MEM`, `CLK`, `OUT`, `IN`) makes
blocks distinguishable at a glance.

### Implementation

- [`server/src/render/symbolAdapter.js`](../server/src/render/symbolAdapter.js) —
  `schematic-symbols` → SVG fragments (scale, translate, Y-flip).
- [`server/src/render/circuitDiagram.js`](../server/src/render/circuitDiagram.js) —
  the renderer.

**Layout is deterministic by construction** — no solver, no randomness, no
timestamps. Components sort by `(column(part_class), CLASS_ORDER, ref_id)`; nets
sort by name; routing channels are assigned from the sorted net index. Sources sit
left, the processor centre, peripherals right — conventional reading order.
Verified: three renders of `noise_pollution_monitor.json` produce byte-identical
SVG (`615e306b802b4199`).

## Option 3 — Graphviz

**Not needed, and not used.** The plan permits it only as a last resort with
deliberate styling and a rendered proof. Option 2 worked, so this was never
reached. Nothing Graphviz-based ships.

---

## Rendered samples

Generated by `cd server && node scripts/render-circuit-samples.js` into
[`docs/samples/`](samples/) — SVG (the real artifact) and PNG (for viewing).

| Fixture | Sample |
|---|---|
| `rc_car` (3 components — simplest) | [PNG](samples/circuit-rc_car.png) · [SVG](samples/circuit-rc_car.svg) |
| `smart_dustbin` (7) | [PNG](samples/circuit-smart_dustbin.png) · [SVG](samples/circuit-smart_dustbin.svg) |
| `gas_leakage_detector` (8) | [PNG](samples/circuit-gas_leakage_detector.png) · [SVG](samples/circuit-gas_leakage_detector.svg) |
| `noise_pollution_monitor` (8, most complex) | [PNG](samples/circuit-noise_pollution_monitor.png) · [SVG](samples/circuit-noise_pollution_monitor.svg) |

### Why these satisfy "visually resembles an electronics circuit"

Judged against the actual rendered output, not the intent:

1. **Standard EE symbols** — real ground glyphs at every ground termination and a
   VCC glyph on the power rail, taken from the same symbol library tscircuit uses.
2. **Wire-style connections** — orthogonal runs with junction dots, entering
   components at labelled pin stubs. Not abstract graph edges between node centres.
3. **Power distribution drawn as a rail**, the way a circuit diagram does it, with
   drops into each part — not 6 redundant pairwise `POWER_n` links.
4. **Decluttered** — U2 in `rc_car` is a 289-pad BGA; the circuit diagram shows the
   two pins that matter (`VDD`, `SDA`), the schematic shows all of them.
5. **IC blocks with pin-1 notches and reference designators** — the conventional
   depiction of an IC in a circuit diagram.

It reads as a circuit, not as a node-edge graph. That was the bar.

### Known limitations (honest)

- **Blocks, not per-part symbols, for ICs.** Correct idiom for ICs, but if
  discretes (resistors/capacitors/LEDs) ever appear in upstream data, they should
  map to their real symbols — `schematic-symbols` already has them, and the
  adapter supports it. Not needed for the current fixtures, which are all ICs.
- **Fixed three-column layout.** Fine to 8 components (all fixtures). A design
  with many more parts per column would need pagination or a smarter layout.
- **Nets are chained pairwise** (A→B→C) rather than routed as a true multi-drop
  bus. Visually correct for the fixtures; a shared bus would read better as a
  trunk line.
- **No crossing minimisation.** Wires may cross. Circuit diagrams tolerate this
  (real ones use crossovers constantly), and avoiding it would require a solver,
  which would put determinism at risk for little gain.
