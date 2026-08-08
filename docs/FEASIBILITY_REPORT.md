# tscircuit Feasibility Report — Phase 2

**Date:** 2026-08-09
**Method:** current docs/repos (sources cited inline) **plus** an executable spike in
[`spikes/phase2-tscircuit/`](../spikes/phase2-tscircuit/) that was actually run.
Every "confirmed" claim below is backed by a spike run, not by documentation alone.
**Versions tested:** `@tscircuit/core@0.0.1631`, `@tscircuit/eval@0.0.1158`,
`circuit-to-svg@0.0.400`, `circuit-json-to-kicad@0.0.171`,
`circuit-json-to-gerber@0.0.90`, `circuit-json-to-gltf@0.0.113`, `circuit-json@0.0.465`.

---

## Bottom line

**No blocker. All four required outputs export to real files, headlessly, offline,
in a plain Linux container.** The spike produced 9/9 artifacts on macOS and 9/9
again inside `node:22-slim` with `--network none` — no browser, no display, no GPU.

The gating question from section 0 of the plan ("can each of the four become a
real file, not just a live render?") is **answered yes for all four, with no
conversion hacks required.** No headless-browser screenshotting is needed; every
output has a native Node export path.

**The real risks are not about capability — they are about silent wrongness.**
Two findings below (R1, R2) are the ones that should shape Phase 3–5 design.

---

## Per-output file-export table

The plan's required deliverable. "Confirmed" = produced as a file by the spike.

| # | Required output | Format(s) confirmed | Exact method | Headless | Offline | Status |
|---|---|---|---|---|---|---|
| 1 | **Circuit diagram** (connectivity) | `.svg`, `.netlist` | `convertCircuitJsonToSchematicSvg()` (circuit-to-svg); `convertCircuitJsonToReadableNetlist()` (circuit-json-to-readable-netlist) | ✅ yes | ✅ yes | **CONFIRMED** |
| 2 | **Schematic diagram** | `.svg` **and** `.kicad_sch` | `convertCircuitJsonToSchematicSvg()`; `new CircuitJsonToKicadSchConverter(cj).runUntilFinished().getOutputString()` | ✅ yes | ✅ yes | **CONFIRMED** — structured format available, as the plan hoped |
| 3 | **PCB layout** | `.kicad_pcb`, `.svg`, Gerber set + `.drl` | `new CircuitJsonToKicadPcbConverter(...)`; `convertCircuitJsonToPcbSvg()`; `convertSoupToGerberCommands()` + `stringifyGerberCommandLayers()`; `convertSoupToExcellonDrillCommands()` | ✅ yes | ✅ yes | **CONFIRMED** — 9 Gerber layers + drill file |
| 4 | **PCB 3D view** | `.glb`, `.gltf` (`.step` via CLI) | `convertCircuitJsonToGltf(cj, {format:"glb"\|"gltf"})` | ✅ yes | ✅ yes | **CONFIRMED** — valid `glTF` magic bytes |

Measured artifact sizes from the spike (3-chip board modeled on `rc_car.json`):
`schematic.svg` 81 KB · `pcb.svg` 30 KB · `board.kicad_pcb` 30 KB ·
`board.kicad_sch` 46 KB · `board.glb` 343 KB · 9 Gerber layers + `plated.drl`.

Reproduce: `cd spikes/phase2-tscircuit && npm ci && node export-all-four.js`
In Linux: `docker build -t tscircuit-spike . && docker run --rm --network none tscircuit-spike`

### Outputs 1 and 2 are the same renderer

Worth stating plainly: tscircuit has one schematic renderer. The plan treats
"circuit diagram" (connectivity view) and "schematic diagram" (electrical capture)
as two deliverables, but tscircuit's `convertCircuitJsonToSchematicSvg` produces a
proper schematic for both. To make them genuinely distinct artifacts we should
pair the schematic SVG with the **readable netlist** as the connectivity view, or
render a simplified graph ourselves from Circuit JSON. **This is a product
decision to confirm, not a tscircuit limitation.**

---

## The seven questions

### 1. Can it run fully headlessly? Exact packages/APIs?

**Yes — confirmed empirically, including offline in Docker.**

`@tscircuit/eval` is explicitly built to "evaluate tscircuit code to Circuit JSON
in browsers, Node, or in web workers" ([repo](https://github.com/tscircuit/eval)).
The spike used:

```js
import { CircuitRunner } from "@tscircuit/eval"
const runner = new CircuitRunner()
await runner.execute(tsxSource)
await runner.renderUntilSettled()
const circuitJson = await runner.getCircuitJson()
```

There is also `RootCircuit` from `tscircuit` for direct in-process JSX
([docs](https://docs.tscircuit.com/guides/running-tscircuit/programmatically-building-circuits)).
**Prefer `CircuitRunner`** — it accepts code as a *string*, which suits a backend
job that compiles a design from data, and it avoids needing JSX build tooling in
the server.

Compilation is `@tscircuit/core`, a phase-based render pipeline
(SourceRender → PortMatching → PcbComponentRender → PcbTraceRender) producing
Circuit JSON, the universal intermediate
([architecture writeup](https://blog.tscircuit.com/p/how-tscircuit-works-compiling-functional)).
`tsci export` exists as a CLI alternative
([docs](https://docs.tscircuit.com/command-line/tsci-export)) but the **library
API is the better fit** for us: no subprocess, no temp files, direct error access.

**Docker:** `node:22-slim` worked with no extra system packages. The dependency
tree pulls native modules (`sharp`, `@resvg/resvg-js`, `occt-import-js`,
`@tscircuit/krt-wasm`) but prebuilt binaries resolved cleanly on linux/arm64.
Timing: ~2.1 s eval on macOS, ~2.6 s in container, for a 3-chip board.

### 2. Per-output file export

Answered in the table above — all four confirmed. Full format list from
[`tsci export` docs](https://docs.tscircuit.com/command-line/tsci-export):
`circuit-json`, `schematic-svg`, `pcb-svg`, `assembly-svg`, `gerbers`,
`readable-netlist`, `specctra-dsn`, `gltf`, `glb`, `step`, `kicad_sch`,
`kicad_pcb`, `kicad_zip`, `kicad-library`, `spice`.

Note `.step` is listed for the CLI; the spike verified `.glb`/`.gltf` via the
library and did **not** verify `.step`. If STEP is needed for CAD handoff, verify
separately — `occt-import-js` (LGPL-2.1) in the tree suggests it goes through
OpenCascade.

### 3. Symbols / footprints / 3D models — and unknown parts

**This is where our fixtures hurt.** Three sourcing mechanisms:

1. **`footprinter`** — built-in parametric generator. Offline, fast, deterministic.
   Spike confirmed `soic8/16`, `qfn16/48`, `lqfp32/48`, `sot23`, `bga289` all
   generate correct pad counts (`bga289` → 289 pads).
2. **`jlcpcb:` prefix** — fetches real footprints + 3D models from the JLCPCB/EasyEDA
   catalog via a "parts engine"
   ([docs](https://docs.tscircuit.com/footprints/jlcpcb-footprints)).
   Spike confirmed `jlcpcb:C2040` → **57 pads in 1.8 s**, `jlcpcb:C7420051` → 7 pads
   in 4.2 s. **Requires network** and adds seconds of latency per part.
3. **KiCad import** — `kicad-component-converter` / `kicad-to-circuit-json` for
   `.kicad_mod` files.

**Our fixture `package` strings are mostly NOT valid tscircuit footprints.**
Tested verbatim from the fixtures:

| Fixture package string | Result |
|---|---|
| `SOT-23-6` | ✅ 6 pads, correct |
| `DFN-8-EP(2x3)` | ⚠️ **no error, no warning, ZERO pads** — see R1 |
| `SOP-16`, `MAPBGA-289`, `QFN-16-EP(4x4)`, `LQFP-48(7x7)`, `SOIC-8`, `SSOP-24`, `SMD,15.2x11.2mm`, `DIP-18` | ❌ explicit `source_invalid_component_property_error` |

So **8 of 10 fixture package strings fail outright and 1 fails silently.** Phase 3
must own an explicit **package-string → footprint resolution** step. This is
exactly the `FOOTPRINT_NOT_FOUND` case in our error taxonomy, and it will be the
common case, not the exception.

**Good news on hallucination:** when a footprint is invalid, tscircuit emits a
structured `source_invalid_component_property_error` element into the Circuit JSON
rather than inventing a plausible footprint. Missing footprint →
`pcb_missing_footprint_error`. Bad pin reference → `source_trace_not_connected_error`
with a helpful message ("Component `.U1` found, but does not have pin `pin99`").
**These map almost 1:1 onto our error taxonomy** and should be consumed directly,
not re-derived.

### 4. Routing and DRC

Both real and substantial.

- **Autorouting:** `@tscircuit/capacity-autorouter` ships multiple solver
  pipelines and runs automatically during PCB render. The spike's PCB output shows
  genuine autorouted traces **including a layer change** (top→bottom transition
  visible in `out/sanity-pcb.png`). `specctra-dsn` export also exists for external
  autorouters (e.g. Freerouting).
- **DRC:** `@tscircuit/checks` exports a full suite — `runAllChecks`,
  `runAllPlacementChecks`, `runAllRoutingChecks`, `runAllNetlistChecks`, plus
  granular checks: `checkPadPadClearance`, `checkPcbComponentOverlap`,
  `checkPcbTracesOutOfBoard`, `checkViasInPads`, `checkTracesAreContiguous`,
  `checkEachPcbTraceNonOverlapping`, `checkSameNetViaSpacing`, and ~15 more.

This means `ROUTING_FAILURE` and `DRC_FAILURE` in our taxonomy can be populated
from real check output rather than stubbed.

### 5. Is output deterministic?

**Yes for everything that becomes an artifact — with one caveat we can normalize.**

Three consecutive runs of the same input:

| Artifact | Result |
|---|---|
| `pcb.svg` | **byte-identical** across runs |
| `schematic.svg` | **byte-identical** across runs |
| Circuit JSON | hash differs — **one field only** |

The single differing field is `source_unnamed_trace_warning.message`, which embeds
an internal component instance counter (`<trace#205 ...>` vs `<trace#8412 ...>`).
No timestamps, no UUIDs, no coordinate jitter — component IDs are stable
(`source_component_0`). **All geometry is deterministic.**

Even stronger: the SVG and GLB hashes produced on **macOS/arm64 and inside
Linux/node:22-slim were identical** (`schematic.svg` sha `d8a3721571b59954`,
`board.glb` sha `811a23063c8cbd24`). That is cross-platform reproducibility, which
is what the plan's "same input → same output" rule actually needs.

Caveats: Linux produced 465 Circuit JSON elements vs 462 on macOS (diagnostic
elements only — rendered artifacts identical), and the autorouter is the most
likely future source of nondeterminism as designs get denser. **Recommendation:**
strip `#\d+` instance counters from message fields before hashing, pin exact
package versions, and add a determinism regression test in Phase 5 that hashes
artifacts across two runs.

### 6. Manufacturing outputs

All present:

- **Gerbers** — `convertSoupToGerberCommands` + `stringifyGerberCommandLayers`;
  spike produced **9 layers**.
- **Drill files** — `convertSoupToExcellonDrillCommands` + `stringifyExcellonDrill`
  (plated/non-plated).
- **Pick-and-place** — `circuit-json-to-pnp-csv` exports
  `convertCircuitJsonToPickAndPlaceCsv`.
- **BOM** — `circuit-json-to-bom-csv` exists in the ecosystem (not installed in the
  spike; verify when needed).
- **SPICE** — `circuit-json-to-spice` + `@tscircuit/ngspice-spice-engine`, beyond
  our current scope but available.

### 7. Licensing

**Core is MIT, but the npm metadata is a compliance gap worth fixing before shipping.**

The [tscircuit/tscircuit LICENSE](https://github.com/tscircuit/tscircuit/blob/main/LICENSE)
is **MIT** (© tscircuit Inc.) — no commercial or self-hosting restrictions.

However, an audit of the full installed tree (309 packages) found:

| License | Count |
|---|---|
| MIT | 179 |
| **UNKNOWN (no `license` field in package.json)** | **70** |
| ISC | 21 |
| Apache-2.0 | 17 |
| BSD-2/3-Clause | 11 |
| MPL-2.0 | 2 |
| LGPL-2.1 / LGPL-3.0-only | 2 |

**Effectively every tscircuit-authored npm package omits a `license` field** —
including `@tscircuit/core`, `@tscircuit/eval`, `circuit-json-to-kicad`,
`circuit-json-to-gltf`, `schematic-symbols`. Their GitHub repos are MIT, so intent
is clear, but the published artifacts don't declare it. **This is a paperwork risk,
not a legal blocker** — flag it to whoever signs off on third-party licensing, and
consider recording the repo licenses in a vendored manifest.

Copyleft to be aware of:

- `occt-import-js@0.0.23` — **LGPL-2.1**, used for STEP/CAD import. LGPL is fine
  when dynamically linked and unmodified, but **if we ship STEP export, review this.**
- `rollup-plugin-dts` — LGPL-3.0-only, **build-time only**, does not ship.
- `@resvg/resvg-js` — MPL-2.0, file-level copyleft, fine for unmodified use.

Also: `schematic-symbols` and JLCPCB/EasyEDA-sourced footprint and 3D data are
**bundled/fetched assets whose own terms differ from the code license.** Using
EasyEDA catalog data in a commercial product should get a separate look.

---

## Risks

### R1 — Silent zero-pad footprints (**highest severity**)

`footprint="DFN-8-EP(2x3)"` produced **zero errors, zero warnings, and zero pads**,
while still emitting `pcb_component`, silkscreen, and courtyard geometry. The
pipeline reports success and yields a board that looks plausible in SVG and 3D but
**cannot be manufactured** — no copper to solder to.

This is precisely what section 4 of the plan forbids. tscircuit will not catch it
for us.

**Required mitigation in Phase 3/5:** a post-compile assertion in *our* deterministic
layer — for every component, `pad_count > 0` **and** `pad_count` matches the pin
count expected from the resolved part. Fail with `FOOTPRINT_NOT_FOUND` /
`COMPONENT_NOT_FOUND` rather than trusting a clean tscircuit run. **Never treat
"no error elements" as success.**

### R2 — Fixture package strings don't resolve

8 of 10 fail outright (see Q3). A package-string → footprint mapping layer is
mandatory, not optional. Where no confident mapping exists, the honest outcome is
`FOOTPRINT_NOT_FOUND`, **not** a guessed similar footprint.

### R3 — `jlcpcb:` lookups need network and add latency

1.8–4.2 s per part, and they fail offline. For a multi-component board this
dominates job time and introduces an external dependency the deterministic layer
can't control. **Recommendation:** cache resolved footprint JSON in MongoDB/S3 keyed
by part number, so a given part resolves identically forever and re-runs stay
deterministic and offline. This also protects determinism if the upstream catalog
changes.

### R4 — Everything is pre-1.0 and moves fast

Every tscircuit package is `0.0.x` (`@tscircuit/core` is at build **1631**). Expect
breaking changes without semver protection. **Pin exact versions** (no `^`), commit
lockfiles, and re-run the spike as an upgrade gate.

### R5 — Circuit-diagram vs schematic overlap

See the note under the export table — needs a product decision.

### R6 — 3D export degrades noisily but non-fatally

During GLB export, `jscad-electronics` logged
`Failed to generate footprinter model for qfn16: center must be an array...` yet
still produced a valid 343 KB `.glb`. So **a 3D file can be missing component
meshes while still being a valid file.** If 3D fidelity matters, capture these
stderr warnings and mark the artifact `mocked`/degraded via the `mockReason` field
the Job model already has.

---

## Recommendations for Phase 3+

1. **Use Circuit JSON as the compile target**, not TSX strings. Our `ValidatedDesign`
   should compile to Circuit JSON, which every exporter consumes. Generating TSX
   text and evaluating it is an unnecessary stringly-typed hop — though
   `CircuitRunner` remains the pragmatic route while we rely on `<chip>` autorouting.
2. **Consume tscircuit's error elements directly.** Filter Circuit JSON for
   `*_error` types and map them onto our taxonomy; don't re-implement those checks.
3. **Add our own post-compile assertions** on top (R1) — pad counts, every net
   realized as copper, every component inside the board outline.
4. **Cache part resolution** (R3) keyed by part number, with the resolved footprint
   stored as data so re-runs are offline and reproducible.
5. **Pin exact versions and add a determinism gate** in Phase 5 CI.
6. **Plan the footprint-mapping table** as real Phase 3 work — this is the single
   biggest functional gap between our fixtures and a manufacturable board.

---

## Sources

- [tsci export — format list](https://docs.tscircuit.com/command-line/tsci-export)
- [Programmatically building circuits](https://docs.tscircuit.com/guides/running-tscircuit/programmatically-building-circuits)
- [JLCPCB footprints / parts engine](https://docs.tscircuit.com/footprints/jlcpcb-footprints)
- [tscircuit/eval](https://github.com/tscircuit/eval)
- [circuit-json](https://github.com/tscircuit/circuit-json)
- [circuit-json-to-gltf](https://github.com/tscircuit/circuit-json-to-gltf)
- [circuit-json-to-kicad](https://github.com/tscircuit/circuit-json-to-kicad)
- [circuit-json-to-gerber](https://github.com/tscircuit/circuit-json-to-gerber)
- [kicad-component-converter](https://github.com/tscircuit/kicad-component-converter)
- [How tscircuit works](https://blog.tscircuit.com/p/how-tscircuit-works-compiling-functional)
- [KiCad integration writeup](https://blog.tscircuit.com/p/kicad-integration-parsing-and-exporting)
- [tscircuit LICENSE (MIT)](https://github.com/tscircuit/tscircuit/blob/main/LICENSE)
- Primary evidence: [`spikes/phase2-tscircuit/`](../spikes/phase2-tscircuit/) — run it yourself.
