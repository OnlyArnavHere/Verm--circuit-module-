# PROJECT PLAN — PCB & Circuit Design Agent

**Status:** Clean slate, Phase 1 not yet started.
**Owner of execution:** Claude Code, working phase by phase from this document.
**Do not skip ahead.** Each phase ends with a checkpoint deliverable. Do not start the next phase until the current one's deliverable exists and is checked off below.

---

## 0. What this system is

Downstream of an **already-built Hardware Agent** (do not touch it, do not rebuild it), this module takes its JSON output and produces exactly these four outputs, **each as a real exportable file, not just an in-session render**:

1. **Circuit diagram** — must visually resemble an actual electronics circuit (recognizable component symbols/icons and wire-style connections), distinct from the schematic's formal EE capture (full pin-level annotation, net labels, standard schematic symbol library). A generic node-edge graph (e.g. plain Graphviz output) does **not** satisfy this on its own — see Phase 3 investigation below → file (SVG)
2. **Schematic diagram** — proper electrical schematic capture, from tscircuit → file (SVG, plus `.kicad_sch`)
3. **PCB layout** — physical board with footprints, placement, traces, layers → file (`.kicad_pcb` + Gerber set + `.drl`, per Phase 2 findings)
4. **PCB 3D view** — rendered/interactive 3D representation → file (`.glb`/`.gltf`, per Phase 2 findings)

**This is a hard requirement, not a stretch goal.** A design isn't "done" if any of the four only exists as something rendered live in a browser/session — it must be a file that can be stored (S3) and handed to the frontend/other agents to download or display. If Phase 2 finds tscircuit can't natively export one of these to a real file, that's a Phase 2 blocker to solve (e.g. via a conversion step), not something to quietly downgrade to "rendered only."

Generation runs as a backend job. The user doesn't hand-edit mid-generation. After completion, conversational change requests create a new **version** — never overwrite a prior one.

### The one rule that overrides every other design decision

```
LLM Agent  →  Validated Design Spec (deterministic schema)  →  Deterministic Compiler  →  tscircuit  →  Artifacts
```

The LLM interprets and plans. It never directly emits final PCB/schematic geometry that gets trusted blindly. The compiler is deterministic: same `ValidatedDesign` + same compiler version + same component library → same output, every time. tscircuit renders/exports. Keep these three layers structurally separate in the codebase — if you ever find yourself about to have the agent generate tscircuit code and just run it, stop and route it through validation first.

---

## 1. Upstream contract (from the Hardware Agent — do not change without strong reason)

```json
{
  "schema_version": "1.0",
  "design_name": "string",
  "components": [
    { "ref_id": "U1", "part_class": "processing|sensor|output|communication|power|storage|clock|input",
      "part_number": "string", "package": "string", "quantity": 1 }
  ],
  "nets": [
    { "name": "string", "connections": ["U1.PIN", "U2.PIN"], "net_class": "ground|power|signal" }
  ],
  "constraints": {
    "layer_count": 4,
    "board_outline": { "shape": "rectangle", "width_mm": 100, "height_mm": 60 }
  }
}
```

Pin refs (`U1.SDA`) are logical, not physical pad numbers. This module resolves logical → physical → pad. Keep the Hardware Agent's contract clean; physical resolution is entirely our problem.

### Real test data: `test-fixtures/`

Four real Hardware Agent outputs: `rc_car.json` (3 components, simplest — use for the first POC), `smart_dustbin.json`, `gas_leakage_detector.json`, `noise_pollution_monitor.json` (most complex, contains known bugs — use to prove the validator).

**Known bugs already found in this real data — the validator MUST catch these, not pass them through silently:**

| File | Net(s) | Bug |
|---|---|---|
| `smart_dustbin.json` | `SPI_10` | `U7.SCK` wired to `U1.MOSI` — clock pin tied to data pin |
| `noise_pollution_monitor.json` | `SPI_8`, `SPI_10` | Same SCK↔MOSI pattern, twice |
| `noise_pollution_monitor.json` | `I2C_7`, `I2C_11` | Both terminate at `U1.SDA` but never join each other's `SCL` — should be one shared bus, modeled as two disconnected half-nets |
| `smart_dustbin.json`, `noise_pollution_monitor.json` | `POWER_1..N` | Redundant — `POWER_RAIL_3V3` already includes all these pairwise connections |

Treat the Hardware Agent's nets as **claims to verify**, not ground truth. If you "fix" a bug like SCK↔MOSI, log it as a recorded modification with a reason (per section 5) — don't silently reroute and say nothing.

---

## 2. Stack (decided — do not re-litigate without a hard blocker)

- **New standalone repo.** Will plug into an existing platform later — keep a clean API boundary (job in, status/artifacts out) so that's a connection, not a rewrite.
- **MERN** (MongoDB, Express, React, Node). Flexible if you hit a real blocker — log it in `DECISIONS.md`.
- **Frontend (temporary/dev-only):** minimal upload UI, accepts a Hardware Agent JSON file. No auth, no polish.
- **Other agents in the platform need visibility** into job status/output → use **Socket.IO** for live progress events, and persist job/design state to **MongoDB** so it's readable by other agents asynchronously too, not just live.
- **AWS S3** (already set up, 6-month free tier — flag the expiry date as a risk in the feasibility report, don't hard-block on it) for storing generated artifacts once they exist.
- **Docker**: get **headless tscircuit execution** working reliably in a container — this is the first real unknown, since tscircuit assumes a browser UI. Solving this is priority one of Phase 2.
- **Gemini API**: optional, narrow use only — sanity-checking incoming JSON structure before it enters the pipeline. Never in the deterministic compiler path, never generating circuit/schematic/PCB content.

---

## 3. Phased plan with checkpoints

Each phase has a **Definition of Done**. Don't move to the next phase until it's met. Update the checklist at the bottom of this file as you go.

### Phase 1 — Repo & job skeleton
Build: MERN skeleton, minimal upload frontend, Express endpoint that accepts a JSON upload, a Job model in MongoDB (include an `outputs` field shaped to hold 4 file references — circuit/schematic/pcb/3d — even though nothing populates it yet), Socket.IO wired up to emit job status events, and a basic S3 upload/download helper (test it with a dummy file — confirm the credentials actually work before Phase 5 needs them for real).
**Definition of done:** uploading any of the 4 fixtures creates a job record in MongoDB and emits at least a "received" socket event; a test file round-trips through S3 successfully. No design generation yet — this phase is plumbing only.

### Phase 2 — tscircuit feasibility (research-heavy, do not assume)
Investigate the **current, real** tscircuit ecosystem via its official repos/docs — do not rely on possibly-stale training knowledge. Answer with sources:
1. Can it run fully headlessly? Exact packages/APIs?
2. **For each of the 4 required outputs specifically, can it export a real file headlessly (not just render in a session)? Name the exact format(s) and the exact API call/package that produces the file.** This is the gating question — if tscircuit can't export one of the four to a file, identify a conversion path (e.g. render → headless-browser screenshot to SVG/PNG, or an intermediate library) rather than reporting it as simply "no."
3. How are symbols/footprints/3D models sourced — and what happens when a real part number (like the ones in our fixtures) isn't in its library?
4. What routing and DRC capabilities exist?
5. Is output deterministic given the same input?
6. What manufacturing outputs are supported (Gerbers, drill files, BOM, pick-and-place)?
7. Licensing — core packages and any bundled assets, commercial/self-hosting restrictions?

**Definition of done:** `docs/FEASIBILITY_REPORT.md` answering all of the above with sources, and a **per-output file-export table** (Circuit / Schematic / PCB / 3D → confirmed format, confirmed method, confirmed headless — yes/no/needs-conversion). If any output can't be exported to a real file even via conversion, that's a red flag to raise immediately, not something to soften — it's a hard MVP requirement per section 0.

### Phase 3 — `ValidatedDesign` intermediate schema + footprint resolution

**First, before schema work: settle how the circuit diagram gets rendered.** This was left open after Phase 2 — do not default to a generic Graphviz node-edge graph and call it done. Investigate, in order:
1. **Does tscircuit itself expose any mode that produces a circuit-diagram-style view** — e.g. a simplified/decluttered render (no pin numbers, no net labels, symbol-only), a different export config, or a community package built on top of tscircuit for this purpose? Check current tscircuit repos/docs/examples, don't assume based on Phase 2's schematic-only finding — that finding was about the *schematic* renderer specifically, not necessarily the ceiling of what the ecosystem offers.
2. **Is there another deterministic renderer** (e.g. `schemdraw`-style symbol-based drawing, KiCad's own schematic plotter run against the `.kicad_sch` we already generate but with annotation layers hidden, or a symbol library keyed by `part_class` rendered with a deterministic layout engine) that produces something that actually looks like a circuit — recognizable component symbols and wire-style connections — rather than an abstract graph?
3. **Only if 1 and 2 don't pan out within reasonable effort**, fall back to Graphviz — but if you do, it must be deliberately styled to look circuit-like (component-shaped nodes per `part_class`, not generic boxes/circles; wire-style edges, not arbitrary graph edges) and you must show a rendered sample and explicitly state why it satisfies "visually resembles an electronics circuit" before treating it as done. An unstyled default Graphviz render is not an acceptable final answer even as a stopgap — don't ship it silently.

Document the investigation and chosen approach in `docs/CIRCUIT_DIAGRAM_APPROACH.md` with a rendered sample attached/referenced. This is a real decision point, not busywork — pick something and move on, but show your reasoning.

Then: design the `ValidatedDesign` schema that sits between the agent and the compiler — independent enough of tscircuit that it could be swapped later. Must represent: resolved components (symbol/footprint/3D refs, resolved physical pins), resolved nets (physical pads, de-duplicated), board constraints.

**Added scope from Phase 2 findings — this is now mandatory, not optional:**
- **Package → footprint mapping layer.** Phase 2 found 8/10 real fixture package strings (`MAPBGA-289`, `QFN-16-EP(4x4)`, `SOP-16`, etc.) don't resolve directly as tscircuit footprints — only `SOT-23-6` did. Build this as its own module: input a `package` string, output either a confident footprint match or `FOOTPRINT_NOT_FOUND`. No lookalike/fuzzy substitution when unsure — an honest error beats a wrong footprint every time.
- **Consume tscircuit's native error elements** (`source_invalid_component_property_error`, `pcb_missing_footprint_error`, etc.) directly into the `ValidatedDesign`/error taxonomy rather than re-deriving equivalent checks from scratch — Phase 2 confirmed these map ~1:1 onto section 4's error codes.
- **Independent pad-count assertion.** Phase 2 found a footprint (`DFN-8-EP(2x3)`) that renders with zero errors/warnings but zero pads — silkscreen and courtyard draw fine, board is unmanufacturable. "No error elements" is not sufficient for validity. The schema/validator must independently assert expected pad count per component and treat a mismatch as a hard failure, not rely on tscircuit's silence as a green light.

**Definition of done:** `docs/CIRCUIT_DIAGRAM_APPROACH.md` with a chosen, justified rendering approach and a sample proving it looks circuit-like, not graph-like; `docs/VALIDATED_DESIGN_SCHEMA.md` with the schema and rationale, validated by hand against `rc_car.json`; footprint-mapping module resolves `SOT-23-6` correctly and returns `FOOTPRINT_NOT_FOUND` (not a guess) for the other 9 known-unresolved packages from the fixtures; a test proving the zero-pad case is caught.

### Phase 4 — Agent vs. deterministic-layer architecture
Document concretely: what the LLM agent layer owns (interpretation, component-resolution decisions, ambiguity handling, explaining errors, modification requests) vs. what the deterministic layer owns (schema validation, pin mapping, connectivity/protocol validation, footprint assignment, routing, DRC, artifact generation). Include the explicit error taxonomy: `COMPONENT_NOT_FOUND`, `PIN_NOT_FOUND`, `FOOTPRINT_NOT_FOUND`, `MODEL_3D_NOT_FOUND`, `INVALID_NET`, `ELECTRICAL_CONFLICT`, `UNSUPPORTED_COMPONENT`, `ROUTING_FAILURE`, `DRC_FAILURE`, `BOARD_CONSTRAINT_FAILURE` — what triggers each, what the response shape looks like.
**Definition of done:** `docs/ARCHITECTURE.md`.

### Phase 5 — Minimal end-to-end POC, real-component-first
**Revised requirement: mocks are a fallback for what genuinely can't be resolved, not a default.** For every component in the fixture(s) used, actually attempt resolution — pinout, symbol, footprint, pad geometry, 3D model where available — using what's already built: the footprint mapper (Phase 3) and the cached `jlcpcb:` parts engine (D-011). Only fall back to a mock for a specific field that resolution genuinely can't produce, and that field must be tagged `source: "mock"` and surfaced explicitly in the output — never silently substituted, never rolled up into a single opaque "mocked" flag that hides which fields actually succeeded.

**Track resolution per field, not per component.** A component with a verified real footprint but an unresolved pinout is not the same state as one that's entirely mock — record `source: "real"` / `source: "mock"` independently for `symbol`, `footprint`, `pads`, `model_3d`, and `pins`, so the honest partial-progress state is visible rather than collapsed into a binary.

**Use two fixtures, not one.** `rc_car.json`'s three components (`SOP-16`, `MAPBGA-289`, `QFN-16-EP(4x4)`) are all in the 9-of-10 that failed footprint resolution in Phase 3 — running Phase 5 on `rc_car.json` alone would never actually exercise the real-resolution path, only the fallback. Also run whichever fixture contains a `SOT-23-6` part (the one package that *does* resolve per Phase 3) — `smart_dustbin.json`, `gas_leakage_detector.json`, or `noise_pollution_monitor.json` all have one — specifically to prove the real-resolution path executes and produces a genuinely real footprint, not just to prove the mock fallback works.

Push both through: parse → resolve (real-first, mock-fallback-per-field) → validate → compile → tscircuit → **produce actual files on disk (and uploaded to S3) for all 4 outputs.** Separately, confirm the validator still catches all four known bugs from section 1's table against `noise_pollution_monitor.json`.

**Definition of done:** working code in the repo; all 4 output files present for both fixtures with a manifest; the manifest/design record shows per-field resolution source for every component (not a single mock/real flag); the `SOT-23-6`-containing fixture demonstrates at least one component with a genuinely real (not mocked) footprint end-to-end; `docs/POC_RESULTS.md` stating exactly what resolved for real, what fell back to mock and why, and confirmation the 4 known bugs were caught. **Do not report Phase 5 as successful on the basis of a fully-mocked design when real resolution was available and unused.**

### Phase 5.5 — Wire in DRC (small, before Phase 6)
`@tscircuit/checks` is already integrated per Phase 2 but not invoked — `DRC_FAILURE` never fires. This is closing a dead path in the existing taxonomy, not new scope: call the existing checks against both Phase 5 fixtures and confirm `DRC_FAILURE` populates correctly when expected.
**Definition of done:** DRC checks run as part of the pipeline; at least one deliberately-bad test case (can reuse a known-bug fixture) confirms `DRC_FAILURE` fires.

### Phase 5.6 — Fix resolution-integrity defects (before Phase 6 continues)
Two real defects surfaced by the resolution audit — both must be fixed before Phase 6 builds further on top of this layer:

1. **False `real: true` claim on 3D models.** `resolver.js:100` sets `model_3d.source` equal to the footprint's source with a `pendingCompileConfirmation` flag that's written once and never read; `compile.js` counts `cad_components` but never feeds the result back to correct the manifest. This produced a false-real claim (U6 reported `real: true` with no actual 3D model) — exactly the failure mode this whole system exists to prevent (section 4/14). Fix: the flag must actually gate the claim, or the manifest must be corrected post-compile from ground truth (actual `cad_components` presence), not from an unverified pre-compile guess.
2. **False determinism/offline claim.** Only the LCSC code and pin names are cached (`parts-cache.json`, `pinout-cache.json`) — footprint geometry and 3D model are fetched live at compile time from `registry-api.tscircuit.com` and `modules.easyeda.com`, no local cache. D-011's offline/deterministic intent is only half-implemented. Fix: cache resolved footprint geometry and 3D model data locally after first fetch (same pattern as the well-known `jlcparts` project — download once, query locally), so re-runs are genuinely deterministic and don't depend on tscircuit's community infrastructure staying up. Note: this infrastructure has been shut down before under similar circumstances (a comparable community JLCPCB-data tool was taken down in 2022) — local caching also reduces that exposure, not just a purity concern.

**On data source (resolved, not changing):** JLCPCB has an official Components API, but it's partner-gated (approval tied to order history/business relationship via api.jlcpcb.com) — not obtainable in this timeline and not guaranteed at all. The current `jlcsearch.tscircuit.com` → LCSC/EasyEDA chain is the same category of community-standard approach the wider ecosystem relies on (no meaningful public alternative exists). Not changing the source. Optionally, applying for official JLCPCB API access is worth doing in parallel as a non-blocking future-hardening step — not Phase 6 work.

**Definition of done:** manifest `real` claims are verified against actual compiled output, not pre-compile assumptions (add a test proving a case like U6 now reports correctly); a second run of an already-resolved fixture produces identical output with zero new network calls for previously-resolved components.

### Phase 6 — Pin-name resolution via datasheet mux tables (post-checkpoint)
**Scope bounded: resolve only the logical pin names actually referenced in the four fixtures' nets, not full per-part datasheets.** Full BGA/MCU pinouts are unbounded scope and violate the project's own MVP principle (section 15 — constrained set first, expand later). Enumerate the exact required pins per part from the fixture nets before starting each part, and stop there.

`curatedPinouts.js` is the mechanism (proven in the `sot23_6`/`HY2111-GB` slice — keyed by part number, not package, with empirical pad-correspondence verification). Remaining known needs from the four fixtures: `MIMXRT1172CVM8A` (SDA/SCL/VDD/GND), `FS32K116LFT0MLFT` (SDA/RX/AUDIO + the SPI pin once the SCK/MOSI bug is resolved, VDD/GND), `MC9S08DZ32ACLC` (SCL/ANT/GPIO1/AUDIO/VDD/GND) — confirm this list against the actual fixture nets before starting, don't assume it's complete.

**Not required for checkpoint success:** resolving every part. `PIN_NOT_FOUND` on an unresolved part is the correct, honest failure mode this system is designed to produce — it's not a gap to panic-close before calling the POC done.

**Definition of done:** documented approach for extending `curatedPinouts.js`, plus verified entries added incrementally as time allows — not a hard requirement to resolve every remaining pin before moving on.

---

## 4. Failure handling (non-negotiable)

The system fails **explicitly**, never silently and never by guessing:

```
COMPONENT_NOT_FOUND, PIN_NOT_FOUND, FOOTPRINT_NOT_FOUND, MODEL_3D_NOT_FOUND,
INVALID_NET, ELECTRICAL_CONFLICT, UNSUPPORTED_COMPONENT, ROUTING_FAILURE,
DRC_FAILURE, BOARD_CONSTRAINT_FAILURE
```

Never claim a design is valid when critical validation failed. Never hallucinate a pinout/footprint/3D model for a part you can't verify — return a structured error instead.

---

## 5. Working rules for this repo

- Commit to git after each phase, with a message referencing the phase.
- Keep `DECISIONS.md` updated with every non-trivial choice made without asking — especially any deviation from section 2's stack decisions or section 1's upstream contract.
- Any time the validator "corrects" something (like the SCK↔MOSI bug), log the original value, the correction, and the reason in the job/design record — never silent correction.
- Prioritize Phase 2 accuracy over speed. A wrong assumption about tscircuit's capabilities discovered on day 2 is much more expensive than an honest "it can't do X" on day 1.

---

## 6. Checklist (update as phases complete)

- [ ] Phase 1 — Repo & job skeleton
- [ ] Phase 2 — tscircuit feasibility report
- [ ] Phase 3 — ValidatedDesign schema
- [ ] Phase 4 — Architecture doc
- [x] Phase 5 — Minimal POC (real-first resolution: rc_car.json + smart_dustbin.json end-to-end, 18/19 parts resolved for real; validator proven against noise_pollution_monitor.json, all 4 known bugs + 5th I2C SCL↔SDA bug caught)
- [ ] Phase 5.5 — DRC wired in
- [ ] Phase 5.6 — Resolution-integrity fixes (false real:true bug, false determinism/no-cache bug)
- [ ] Phase 6 — Pin-name resolution via datasheet mux tables (starting with curated sot23_6 entry)
