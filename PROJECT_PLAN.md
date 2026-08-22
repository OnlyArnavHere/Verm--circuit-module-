# PROJECT PLAN — PCB & Circuit Design Agent

**Status:** Clean slate, Phase 1 not yet started.
**Owner of execution:** Claude Code, working phase by phase from this document.
**Do not skip ahead.** Each phase ends with a checkpoint deliverable. Do not start the next phase until the current one's deliverable exists and is checked off below.

---

## 0. What this system is

Downstream of an **already-built Hardware Agent** (do not touch it, do not rebuild it), this module takes its JSON output and produces exactly these four outputs, **each as a real exportable file, not just an in-session render**:

1. **Circuit diagram** — a stylized, approachable pictorial wiring diagram: generic icon art per `part_class` (not per exact part number — no realistic image exists for e.g. a bare BGA-289, so icons represent the category: microcontroller, sensor, power regulator, etc.), connected with clean, color-coded wires. Deliberately distinct from the schematic's formal EE notation, and deliberately *not* a literal photorealistic breadboard scene — see Phase 7 for why that assumption doesn't map to this project's actual (SMD/chip-level) components, and what's built instead → file (SVG)
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
- **Gemini API**: sanity-checking incoming JSON structure (original scope), plus — as of Phase 6 — datasheet-grounded pin-mapping research under strict conditions: only called with a real fetched datasheet in hand, output gated by a structural check (claimed pin exists in the compiled footprint) and an anti-hallucination check (evidence excerpt must substring-match the real source document), and human-confirmed before being trusted. Never used to generate circuit/schematic/PCB content directly, and never treated as authoritative on its own — see Phase 6 for the full boundary.

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

**Update after checkpoint review (post-Phase 6):** the `schematic-symbols`-based renderer built here (351 real EE symbols, net-participating-pins-only, grounds-as-symbols, power-collapsed — D-015's rules) is being **restyled, not discarded**, in the new Phase 7. The connectivity-simplification logic stays; the visual symbol set changes from real EE symbols to generic stylized icons per `part_class`. See Phase 7.

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

`curatedPinouts.js` is the mechanism (proven in the `sot23_6`/`HY2111-GB` slice — keyed by part number, not package, with empirical pad-correspondence verification).

**Groups, by resolution difficulty (confirmed against real fixture nets):**
- **Group A** (part already exposes matching named pads) — done: `RF-BM-2340A2I.GND` resolved for real. `RF-BM-2340A2I.TX` and `MBI5124GP-B`'s `AUDIO`/`GPIO1` are **upstream Hardware Agent data errors** (no TX pin exists; the LED driver has neither function) — logged under a distinct "UPSTREAM DATA ERRORS" section in `docs/POC_RESULTS.md`, not resolution gaps a datasheet could ever fix.
- **Group B and Group C are now one track, not separate.** The A/B/C split only ever reflected how much manual effort was needed, not a difference in mechanism — `FS32K116LFT0MLFT`'s remaining pins and `MIMXRT1172CVM8A` need the same datasheet-grounded path as the rest of Group C. Run them through the same pilot mechanism below once it's proven, don't build a separate bespoke path for Group B.

**Gemini-assisted datasheet extraction, now with automated dual-independent-extraction verification instead of a per-pin human gate:**
1. Only call the extractor with a real, already-fetched datasheet. Fetch order: LCSC's stable unsigned link (`lcsc.com/product-detail/<code>.html` → `datasheet.lcsc.com/datasheet/pdf/<hash>.pdf`, confirmed working) first, JLCPCB's signed OSS link as fallback (confirmed session/referer-independent failure — its signature binds to something a scripted client can't reproduce, not just missing cookies). If no datasheet fetches, go straight to `PIN_NOT_FOUND`, no model call.
2. **Extractor A (Gemini, `gemini-flash-latest`):** reads only the datasheet, proposes `logical_pin`, `physical_pin`, near-verbatim `evidence`.
3. **Deterministic gates on Extractor A's proposal:** Gate 1 (structural) — claimed pin exists on the compiled footprint. Gate 2 (anti-hallucination) — `evidence` fuzzy-matches a substring of the actual extracted datasheet text, checked in code. Self-reported confidence is never a gate.
4. **If Extractor A passes both gates: Extractor B (Groq — a genuinely different model family, not a second Gemini call) independently re-extracts the same target pin from the same datasheet, blind to Extractor A's proposal.** Not a confirmatory "does this look right" check — Extractor B doesn't see Extractor A's answer or evidence at all, it does its own extraction from scratch. Extractor B's proposal runs through the same two deterministic gates independently.
5. **Auto-accept only on independent agreement:** if both extractors land on the same physical pin, and both independently passed both gates, the entry enters `curatedPinouts.js` automatically — no human step. This is the actual speed gain: unambiguous parts (most of them) clear without anyone reviewing them.
6. **Disagreement (or either extractor failing a gate) routes to human review**, via `confirm-extraction.js`, presenting both proposals and both evidence excerpts side by side so the reviewer sees exactly what the two extractors disagreed about — same script as before, now only invoked on the cases that actually need a human, not every case.
7. Cache with full provenance: datasheet URL, both extractors' proposals, both gate results, agreement outcome, and (for disagreement cases) confirmer/timestamp.

**Why not a confirmatory second call:** a second pass that's shown the first proposal and asked to verify it is vulnerable to anchoring, and doesn't bring a structurally different failure mode — it's still pattern-matching over the same ambiguous text. Independent blind re-extraction is the part that actually catches disagreement. This matters concretely here: `LP103SB6F`'s real near-miss (a per-package table giving the correct `GND=pin2`, a package diagram naively reading as the wrong `pin5`, both genuinely verbatim in the datasheet, both would pass both deterministic gates) is exactly the kind of case a confirmatory check could rubber-stamp but independent re-extraction is positioned to catch as a disagreement.

**Required validation before trusting this design at scale:** retroactively reconstruct the `LP103SB6F` near-miss as a controlled test — force one extraction path to see only the diagram (withholding the table) so it proposes the wrong `pin5`, run the real independent extractor against the full datasheet, and confirm the comparator correctly flags disagreement rather than auto-accepting either answer. This tests the design against the one known real failure mode before it's trusted on parts nobody's checked by hand.

**GROQ_API_KEY is being added to `.env` for Extractor B** — check for it before assuming Extractor B is unavailable.

**Pilot status: proven end-to-end, one part confirmed.** `LP103SB6F.GND` → `pin2`, both gates passed, human-confirmed, in `curatedPinouts.js`. `LP103SB6F.VDD` correctly stayed `PIN_NOT_FOUND` (the part has no VDD pin — its supply is an internally-generated rail, `PS` — and the model correctly declined to invent one).

**Scope expansion approved.** The pilot has now proven itself twice (`LP103SB6F`, `HY2111-GB`) — Group B and the rest of Group C are no longer on hold. Proceed with:

**Priority 1 — finish Group B, completes the two showcased fixtures:**
- `MIMXRT1172CVM8A` (`GND`/`SDA`/`VDD`) — expect this to be genuinely harder than anything resolved so far: it's a 289-ball BGA (NXP i.MX RT1170-class part), likely a large, complex datasheet, possibly with pin-mux detail split across a separate reference manual from the main datasheet. A lower resolution rate here than on the SOT-23-6 parts is expected, not a pilot failure — honest `PIN_NOT_FOUND` on the balls that don't extract cleanly is correct, don't lower the evidence bar to force a higher hit rate on a hard part.
- `FS32K116LFT0MLFT` (`AUDIO`/`MOSI`/`RX`/`SDA` — `VDD`/`GND` already real via the rail rule).
- `TP4110`'s `VDD`/`VIN` question — currently honestly unresolved because it only exposes `VIN`. Don't assume `VIN` is just `VDD` by another name; run it through the same datasheet-verified path as everything else (it may turn out `VIN` genuinely is the correct real answer, but that needs the same evidence discipline as every other mapping, not an assumption). Resolving this completes `rc_car.json`'s power component.

**Priority 2 — remaining Group C parts** (`BLE-SER-A-ANT`, `CD4543BM96`, `ESPC2-12-N4`, `HDSP-521G`, `LMA2718T421-OA5-2`, `MC9RS08KA1CSCR`, `MC9S08DZ32ACLC`, `MCP7940NT-I/SN`, `MCP9808T-E/MC`, `PS-5850SVB-6PNW`).

**Batch, don't drip-feed the review.** Run extraction across all remaining parts, let both deterministic gates run, then present everything that passed both gates together in one batch report for confirmation — not one part at a time in separate round trips. Whatever fails either gate or has no fetchable datasheet reports as `PIN_NOT_FOUND` in the same batch report, no separate escalation needed for those. If `confirm-extraction.js` doesn't yet support confirming multiple pins in one invocation, add that rather than requiring one command per pin.

**Standing rule, surfaced by three separate incidents this phase (a 413 read as extractor disagreement, an empty pinout cache read as model failure, a 429 read as `PIN_NOT_FOUND`): a transport/infrastructure failure must never be reported as a domain-level negative result.** Failing explicitly (section 4) isn't sufficient on its own — the failure code has to be the *correct* one. `PIN_NOT_FOUND` must mean "we genuinely tried and the datasheet doesn't support it," never "the API call failed partway." Use a distinct status (`NOT_ATTEMPTED`) for anything that didn't actually complete, with backoff/quota-exhaustion handling that stops honestly and names exactly what wasn't reached, rather than letting incomplete runs silently degrade into false domain answers.

**Batch status: partial, quota-blocked, not yet a real signal on hit rate.** Gate 1's empty-pad-list bug (rejecting valid claims when a footprint's pinout cache entry was missing, fixed — 11 missing footprints populated) had been silently preventing Extractor B from ever being invoked in batch context, since B only runs on A's gate-passing claims. **Extractor B has not yet run at scale — only in the isolated near-miss test.** Don't draw conclusions about the dual-extraction design's real-world agreement/disagreement rate from any run before this fix took effect.

**Key-level rotation added on top of provider-level failover.** Multiple keys per provider now available (`GEMINI_API_KEY`/`_2`, `Groq_API_KEY`/`_2`), plus Ollama as an additional fallback tier. When a key's quota is exhausted, rotate to another key with quota for the same provider before considering that provider "down" at the provider-failover level. **Check whether the Ollama key is for local Ollama (no quota at all — meaningfully different value than another rate-limited cloud key) or Ollama's hosted cloud API (rate-limited like the others)** before assuming its resilience value — confirm which before wiring it into the fallback chain.

**Known limitation, stated honestly:** the Phase 6 batch run that prompted this had zero outages and zero `NOT_ATTEMPTED` — quota was not the binding constraint. The dominant remaining failure category (30 of 31 unresolved pins) is source-document limitation (mux tables and BGA ball maps that don't survive PDF text extraction), which more keys/providers cannot address — there's no quota shortage to route around when the datasheet doesn't contain the answer as text. Key rotation is reasonable resilience to have, but shouldn't be expected to move the needle on the parts still unresolved.

**`TP4110.VDD` — resolved as a non-issue for the pipeline, escalated as an upstream finding instead.** `TP4110` is confirmed (same family as the well-known `TP4056`) to be a lithium battery charger IC, where `VIN` is specifically the raw USB/wall-adapter charging input (~4.5–6.5V) — electrically distinct from a board logic supply, not just a differently-named equivalent. Wiring it into `POWER_RAIL_3V3` is very likely an upstream Hardware Agent net-topology error, same category as the SPI/I2C and `MBI5124` findings — not a pin-identification gap for the extraction pipeline to keep chasing. Leave unresolved (current state is correct), log under the same upstream-findings section as the other data-quality issues.

**Yield reality check, logged plainly:** across all of Phase 6's dual-extraction infrastructure (pilot, gates, cross-model comparison, failover, degraded mode), one real pin has been confirmed end-to-end (`LP103SB6F.GND`). A single catalogue-completeness bug fix (D-054) resolved seventeen. The mechanism remains proven only by the controlled near-miss test, not by production yield — worth remembering before investing further engineering time in this specific system versus auditing for more bugs of D-054's shape.

**Phase 6 extraction pipeline declared at practical ceiling — pivoting to catalogue/cache-completeness audit (Phase 6.5).** The remaining unresolved pins are source-document-limited, not pipeline-limited; more extraction infrastructure won't move them. D-054's actual lesson wasn't "fix that one cache," it's that **a rejection caused by our own incomplete cache data looks identical to a genuine resolution failure unless someone checks** — and this has now happened four times in different forms (false `real:true`, false determinism/no-cache, empty pad list, and the general transport-vs-domain-answer pattern). Worth a deliberate sweep rather than waiting to trip over the next instance.

### Phase 6.5 — Catalogue/cache-completeness audit (new, highest proven yield per engineering-hour so far)
**Scope: pure deterministic pipeline work, no LLM calls involved** — cheaper and faster to check than the extraction path, which is exactly why it's next.

For every deterministic gate/check/resolution step in the pipeline that depends on a cache or lookup table, verify it's actually complete for what the 19 real fixture parts need — don't assume, check empirically the same way D-054 was found (that bug was invisible until someone actually inspected why a genuine, correctly-quoted pin-table row was being rejected). Candidates to check, not necessarily exhaustive:
- **Footprint mapper** (Phase 3): are there fixture packages currently reported as unresolved where the actual gap is a missing/incomplete lookup entry rather than a genuine geometry mismatch? (Careful: D-010's exact-match rule rejecting a *different* package geometry, like the `QFN-16-EP(4x4)` vs. plain `qfn16` case, was proven *correct*, not a bug — the audit target is specifically "we have the right footprint identified but a downstream table needed to complete the claim is simply missing an entry," not "we're being appropriately conservative about uncertain matches." Don't loosen D-010's rule while doing this.)
- **Pinout cache** (`pinout-cache.json`): any parts beyond the 11 already fixed with the same gap?
- **3D model resolution**: given the false `real:true` bug was about wrongly *claiming* a model existed, check the inverse — any case where a real, resolvable 3D model is being marked unavailable due to a similar cache gap rather than genuine unavailability?
- **Parts engine matching**: any fixture parts currently unresolved via `jlcsearch` where the actual LCSC entry exists but a fixable matching/lookup gap (not a legitimate uncertainty) is blocking it?

For each gap found: fix it (populate the missing data), then verify the fix against real fixture data the same way D-054's fix was verified (not just "looks right" — re-run the deterministic resolution and confirm the specific parts/pins now resolve).

**Set expectations honestly going in:** D-054 was a genuinely large, possibly one-off find (17 pins from one fix). This audit might find another one that size, several small ones, or none at all — report whatever's actually found, don't manufacture significance if the sweep comes up empty.

**Definition of done:** every cache/lookup dependency in the pipeline explicitly checked (documented, even the ones that turn out fine — this makes the audit itself reusable/re-runnable later, not just a one-time fix), any gaps found fixed and verified, updated real-pin-count reported (currently 32/63) with honest attribution of any change.

**Status: done.** Pin count unchanged (32/63) — the one real gap found (package-generic footprint entries shadowing part-specific catalogue entries, discarding a real resolvable 3D model — the inverse of the false `real:true` bug) affected 3D coverage, not pins. Correctly not oversold as a second D-054. Notable: `LP103SB6F.GND → pin2` independently corroborated from the catalogue's own metadata — the one confirmed extraction-pipeline result now has external validation, not just internal self-consistency. Parts engine, pinout cache, and pin-name matching all verified complete/correct as-is (`BLE-SER-A-ANT` genuinely absent, `FS32K116LFT0MLFT` genuinely only exposes 5 names — both confirmed as real limitations, not bugs).

**Unplanned finding, more valuable than the audit's original goal:** unresolved pins split into two real categories — ~18 genuine mux-table gaps (per D-059, expected), and ~10 pins where **the selected part physically lacks the requested function entirely** (`HDSP-521G` asked for `GND`/`SCK`/`VDD` — it's a 7-segment display; `CD4543BM96` asked for `AUDIO` — it's a BCD-to-7-segment decoder; `LMA2718T421-OA5-2` asked for `SCL` — single-output analog part; `ESPC2-12-N4` asked for `ANT` — integrated-antenna module; plus the known `MBI5124GP-B`). Five instances, consistent pattern: **the Hardware Agent appears to attach a class-typical net without verifying the specific selected part actually supports it.** This is a systemic upstream bug, not five coincidences. *(Root cause since confirmed by reading the upstream generator — it is net construction, not part selection; see the Phase 6.6 status note below and D-076.)*

### Phase 6.6 — Capability-mismatch validation (new, bounded — uses data already resolved)
Build a distinct check, separate from generic `PIN_NOT_FOUND`, for the specific pattern just found: a net requests a function a part's *already-confirmed real capability set* proves it doesn't have (as opposed to "not yet resolved, might exist"). New error code (e.g. `PART_CAPABILITY_MISMATCH`) — don't lump this into `PIN_NOT_FOUND`, which conflates "haven't found it yet" with "this part fundamentally doesn't do this."

This only applies where we already have positively-resolved real capability data for the part (any resolution path — catalogue, curated, or LLM-extracted with human confirmation) — not a new research effort, a new check on data already in hand. Retroactively reclassify the 5 known instances into this category. Make the check general (part's real exposed names vs. requested net function) so it fires automatically on any future Hardware Agent JSON, not hardcoded to these 4 fixtures — this is what makes it worth building rather than just documenting: it protects real future designs, not just these test cases.

**Definition of done:** new error code implemented and distinct from `PIN_NOT_FOUND` in the taxonomy (update `docs/ARCHITECTURE.md`); the 5 known instances reclassified; a test proving the check fires generally (not just on the 4 known fixtures) — e.g. construct a synthetic case with a different part/net combination and confirm it's caught.

**Status: done.** Two synthetic tests (outside any fixture) prove generality. Three guards earned their place from real parts that would otherwise be misreported: complete pad coverage (refuses to assert absence when naming is incomplete — `HDSP-521G`/`CD4543BM96` correctly stayed `PIN_NOT_FOUND`, not forced into the new code despite being on the original suspect list), functional-vs-complete naming (`MIMXRT1172CVM8A`'s 289 ball-coordinate names are complete but not functional — same "field present ≠ field meaningful" lesson as D-054/false-real/false-determinism/3D-shadowing, now appearing a fifth time in a new form), and mux-assignability (a firmware-mappable pin, like `RF-BM-2340A2I`'s `TX`, is a mux gap not a capability mismatch; an antenna feed, like `ESPC2-12-N4`'s `ANT`, genuinely can't be mux-assigned). Final reclassification: 5 pins across 4 parts (`MBI5124GP-B`: `AUDIO`/`GPIO1`; `LMA2718T421-OA5-2`: `SCL`; `ESPC2-12-N4`: `ANT`; `TP4110`: `VDD`) — `TP4110.VDD` converged independently from two unrelated methods (web research on the chip family; this check's own capability data), a second cross-validation moment after `LP103SB6F`'s `GND`.

**Upstream finding, reframed as one root cause — now confirmed at the source (see D-076).** The original inference from this phase was "the Hardware Agent assigns class-typical nets without verifying the selected part actually provides that function — one defect at the selection step." Reading the upstream generator directly confirms the pattern but **relocates the defect: it is not in part *selection*, it is in *net construction*.**

`ai_engine/agents/supervisor/nodes.py` derives every pin name from the **interface type**, never from the selected component: `_interface_pin_name()` maps `I2C -> (SCL, SDA)`, `SPI -> (SCK, MOSI, MISO, CS)`, `Power -> (VDD, VCC, 3V3)` from a fixed table, and `_build_nets_from_architecture()` emits one 2-member net per architecture edge (source takes index 0, target index 1) while attaching `.GND`/`.VDD` to every reference unconditionally. The backing component dataset contains **no pinout data at all — 0 of 490,894 rows have `pins_json`/`pinout`/`symbol`**, so no per-part pinout was ever available to consult.

This subsumes both this phase's 5 capability-mismatch instances **and** all four "known bugs" of section 1 — the SCK↔MOSI pairing, the split I2C half-nets, and the redundant `POWER_1..N` nets each fall directly out of that function. One defect, not two findings and four bugs.

**Correction to the recommended fix:** "validate a net's required function against the selected part's real pin set at selection time" is necessary but insufficient — with no pinout data in the dataset, there is nothing to validate against. The upstream fix must first **source real per-part pinouts**, then emit pin names from them rather than from the interface table. Documented as the lead item in `docs/POC_RESULTS.md`'s upstream section, above the individual instances, so it gets fixed once at the root rather than patched per symptom.

`PART_CAPABILITY_MISMATCH` still earns its place: it is the check that surfaces this automatically on any future Hardware Agent output. But note its scope is now bounded by D-076 — it detects a fabricated pin name that *contradicts* a known-real capability set, and cannot detect a fabricated pin name that happens to *collide* with a real one.

**Provider failover / degraded mode.** If one provider (Gemini or Groq) becomes unavailable mid-batch (quota exhaustion, outage) despite billing, don't stop the batch and don't report it as `PIN_NOT_FOUND` — continue with the remaining provider, but change what "passing" means:

- Deterministic gates (1-3) still run on the single available extractor's proposal, same as always.
- **Gate-passing in single-provider mode never auto-accepts.** Route it to the same batched human review as a disagreement, labeled with the reason (provider outage, not extractor conflict). Rationale: the `LP103SB6F` near-miss already proved a single gate-passing extraction can be confidently wrong — gates check internal consistency, not correctness, which is exactly why independent agreement was required for auto-accept in the first place. A single-provider result has that same evidentiary weakness, not a merely "lower confidence" version of dual-agreement.
- Track `verification_mode` (`DUAL` / `GEMINI_ONLY` / `GROQ_ONLY`) in the provenance record for every result, not just the degraded ones.
- Don't permanently downgrade for the rest of the batch on first failure — retry the failed provider periodically (e.g. every few parts or after a cooldown) rather than treating one outage as down-for-the-whole-run.
- If both providers are unavailable simultaneously, that's still a genuine halt/`NOT_ATTEMPTED` case — failover covers one-of-two down, not zero-of-two, since there's nothing to gate-check with no extraction at all.
- The degraded-mode warning persists on the batch summary and on each affected result's provenance, not just as ephemeral console output — a reviewer looking at results later needs to see why something's `GEMINI_ONLY` without having watched the run live.

**Expanding scope doesn't mean forcing a higher hit rate.** `PIN_NOT_FOUND` on a genuinely unresolvable pin is still the correct, honest outcome — the goal is trying every remaining part with real evidence, not making every pin resolve by any means.

**Definition of done:** Group A resolved (done) with upstream data errors correctly distinguished from resolution gaps (done); pilot proven end-to-end on one real part with both deterministic gates demonstrated catching a real near-miss (done); documented decision on generalizing to the rest of Group B/C (pending — hold until explicitly told to expand scope).

### Phase 7 — Stylized icon-based circuit diagram (new, supersedes Phase 3's visual style, not its logic)
**Why this exists:** the non-negotiable product reference for "circuit diagram" turned out to be Fritzing/Tinkercad-style — but literal photorealistic breadboard imagery assumes breadboard-friendly THT/module parts (an Arduino Uno, a generic sensor module), and this project's real components are SMD/BGA chip-level parts (`MIMXRT1172CVM8A` is a 289-ball BGA) that physically cannot go on a breadboard. There's no "real photo" for most of our fixtures in that style. Decision (see conversation, confirmed): build a **stylized icon-based pictorial diagram** instead — generic per-`part_class` icon art (8 categories: processing, sensor, output, communication, power, storage, clock, input — not per-exact-part, since no realistic image target exists for most real parts), connected with clean, color-coded wires. This keeps the intended *reading experience* (approachable, non-formal, readable by a non-engineer) without a broken realism assumption.

**Reuse, don't rebuild, the connectivity logic.** Phase 3's `schematic-symbols`-based renderer already solved the hard part: which pins to show (only net-participating ones), how to simplify grounds (as symbols) and power (collapsed to one rail) — D-015's rules. Phase 7 swaps the *visual symbol layer* (351 real EE symbols → 8 generic stylized icons) on top of the same underlying `ValidatedDesign` connectivity data and simplification rules. Don't redo the net-simplification work.

**Icon sourcing — original art only.** Do not copy or closely imitate real Fritzing/Arduino/Tinkercad board artwork or any other copyrighted/trademarked component imagery — that's a real IP problem, not just a style risk. Build a small set of original, generic, flat-style icons (one per `part_class`) — simple enough to be unambiguous, distinct enough to be visually identifiable at a glance. Cache/reuse across all designs; this is a one-time asset cost, not per-design work.

**Wire color-coding:** pick a small, consistent scheme (e.g. by `net_class` — ground/power/signal — or a rotating palette per net) and document the rule in `docs/CIRCUIT_DIAGRAM_APPROACH.md` so it's not ad-hoc per render.

**Scope discipline:** this is a rendering-layer change on top of already-computed data, not a new data pipeline. Don't let it balloon into a physical breadboard-grid layout simulator (explicitly rejected — see conversation) or per-exact-part image generation (explicitly rejected in favor of per-category icons).

**Definition of done:** `docs/CIRCUIT_DIAGRAM_APPROACH.md` updated with the icon-based approach, the 8 category icons (original art, not copied), the wire color-coding rule, and a rendered sample per Phase 5's fixtures for comparison against the old EE-symbol version. Icons and wiring are legible and visually distinct from both the schematic and the PCB layout outputs.

**Status: done, verified precisely.** `partIcons.js` (new, icon lookup by `part_class`) plus a material but scoped change to `circuitDiagram.js` (83 insertions/30 deletions) — verified by diff inspection that all changes are constants/imports/SVG-emit lines/a `junctions` data-shape tweak, with **zero lines touching net classification, pin-stub assignment, column assignment, `stubPoint()` coordinates, routing-channel math, or ground/power topology.** Three sizing constants changed (`BLOCK_W`, `BLOCK_MIN_H`, `BLOCK_HEADER`) to make room for the icon — cosmetic geometry, not connectivity logic. Precise claim: the connectivity/routing algorithm is unchanged; the geometry it's parameterized by changed. EE ground/VCC glyphs kept (rails, not parts — universally legible). Category-level icons with part-number disambiguation is by design. Minor net-label collision in `gas_leakage_detector` logged as accepted cosmetic polish (D-044), not fixed.

---

### Phase 8 — Conversational modification workflow (section 12 of the original spec, untouched until now)
**Scope bounded to one modification type: component repositioning** (matches the spec's own example — "move the BLE module closer to the edge"). Explicitly defer component swaps, net/connectivity changes, and board-constraint changes — these cascade through footprint/electrical-validation/compilation in ways that are much riskier, same reasoning as deferring Group C earlier. If a request falls outside repositioning, reject it explicitly as unsupported for now rather than guessing at a broader interpretation.

**First step: propose the structured-instruction and version-storage schemas before implementing** — same "propose the intermediate schema, then build" discipline as `ValidatedDesign` in Phase 3. Don't jump straight to a full implementation.

**Architecture — reuses the LLM-proposes/deterministic-validates pattern already proven in Phase 6, applied to modification requests instead of pin extraction:**
1. User submits a natural-language request against an existing `design_id`/version.
2. Agent (LLM) interprets the request into a small, bounded structured instruction (e.g. target component + a concrete candidate placement or placement strategy) — never free-form tscircuit code, never directly emitting final geometry (section 1's core rule applies here too). Anything that doesn't map cleanly onto the bounded instruction schema is rejected as unsupported, not guessed at.
3. Deterministic validation: does the referenced component exist in the current `ValidatedDesign`? Is the proposed placement well-formed (within board outline, doesn't trivially collide)?
4. A deterministic (not LLM-generated) transform applies the instruction to produce a new `ValidatedDesign` version.
5. Re-run the existing deterministic compiler → tscircuit → regenerate all 4 outputs. **Re-run DRC (already wired in from Phase 5.5)** on the new placement — if the move introduces a DRC violation, fail explicitly and don't commit the new version, rather than silently shipping a worse board than v1.
6. Store as a new version — never overwrite prior versions (`design_001/v1`, `v2`, `v3`...). Persist the natural-language request and the interpreted structured instruction alongside the version, same provenance discipline as everything else in this project.
7. Emit the socket/DB update so other agents can see the new version, per the original visibility requirement.

**Much of the hard infrastructure already exists** — the deterministic compiler, tscircuit pipeline, DRC, and all 4 output generators are reused as-is. What's actually new: the NL→structured-instruction step, the deterministic apply-and-recompile transform, and version storage.

**Definition of done:** structured-instruction and version schemas proposed and reviewed; one real fixture taken through a real natural-language repositioning request end-to-end, producing a genuine v2 with regenerated outputs; v1 confirmed unchanged and still accessible; DRC re-run proven to actually catch a deliberately-bad repositioning (same rigor as the pinLabels/traceCount proofs — not just claimed).

**Prerequisite found and confirmed:** placement was derived at compile time (grid-based), not stored — `ValidatedDesign` had no placement field, so there was nowhere for a repositioning transform to write without reaching into the compiler and breaking the layer separation. Promoting placement to explicit `ValidatedDesign` state (existing grid logic as v1's default generator, per-component `source: auto_grid | modified` so re-layout can't silently discard a human-requested position) is approved — touches Phase 3's schema and Phase 5's compiler, necessarily. Side benefit: closes a latent gap where "design planning" (section 13, an Agent-layer job) was silently living inside the deterministic compiler — worth a one-line note in `docs/ARCHITECTURE.md`, not extra scope.

**Five design decisions confirmed:**
1. Placement prerequisite — approved (above).
2. Rejected modification attempts record on the parent Job as `modificationAttempts`, never as a version document. Versions only ever represent complete, artifact-bearing, DRC-passed designs — same invariant as curated pinouts only getting entries that passed verification.
3. Backfill existing job records (`designId = jobId`, `v1`, `isCurrent: true`) rather than leaving them un-versioned — small one-time deterministic migration, avoids permanent special-casing in every future version-lineage query.
4. `absolute` mode stays, scoped specifically to *extracting user-stated coordinates* ("put it at x=20, y=15"), never to the model inventing a coordinate from a vague request ("near the corner" routes through `edge`/`relative_to` instead, where the deterministic layer resolves actual millimetres). Same deterministic validation (board-outline containment, DRC) applies to `absolute`'s output as every other mode — no shortcut just because a human supplied the number.
5. DRC blocks on new `DRC_FAILURE` count > 0 only, not on any warning increase (9–21 baseline warnings on both fixtures makes a warning-increase gate unworkably strict). Optional, non-blocking addition: surface the warning-count delta in version provenance for visibility, even though it doesn't gate.

**Real end-to-end run: verified, both success and block paths.** "Move the BLE module down to the bottom edge" — interpreted as edge/margin, resolved to real millimetres by the deterministic layer from board outline and actual footprint dimensions (not the model), DRC clean, v2 committed with correctly-selective regeneration (circuit diagram byte-identical since it's a logical not physical view; schematic/PCB/3D regenerated), v1 confirmed unchanged on disk. Separately, a deliberately hard DRC-block case (constructed to clear the cheap bbox pre-check by exactly 0.1mm, so the proof exercises real courtyard-based DRC rather than the guard) correctly blocked with 33 failures, no version committed, v1 unchanged. A genuinely unsatisfiable request ("move to left edge," no physical room) was correctly refused with an explanation rather than shipped as an overlap.

**Two bugs found running it for real, both caught by comparing actual artifacts rather than trusting "looks right":** the placement refactor initially wasn't neutral (a code path didn't carry placement through, emitting boards with zero components) — fixed and re-verified coordinate-by-coordinate against the exact pre-Phase-8 formula for all 7 components. A pre-check bug used resolved pin *count* as a proxy for component *size* (modelling a 15.8mm module as 3mm), wrongly blocking a valid request — fixed to read true extents from compiled geometry, with a regression test asserting the estimate and the real value must differ so the bug can't silently reappear by coincidence.

**One gap closed in the single-extractor design:** DRC and geometric validation catch wrong *coordinates*, not a wrong *target component* — a misidentified-but-structurally-valid ref_id (e.g. "the BLE module" resolved to the wrong part) would pass DRC cleanly, since geometry validation has no way to know the wrong component was moved. Added a cheap semantic sanity check: compare the natural-language component reference against the resolved component's actual `part_class`/`part_number` (data already available, no new extraction needed) — on a clear mismatch, surface it prominently in the response rather than silently committing (doesn't hard-block, but must not be buried in provenance only a person who goes looking would find).

### Phase 9 — Consolidation for handoff/demo (new — final phase, bounded, no new engineering)
This is wrap-up, not further building. The system is feature-complete against the original spec (sections 1–20) as of Phase 8 — this phase makes it legible and safe to hand off, nothing more.

1. **One final clean-state verification run** before anything else: full test suite, one full pipeline run against all four fixtures from a cold state (matching the discipline used throughout — a claim of "it works" needs a fresh proof at the end, not just an assumption built from the cumulative history of individual fixes).
2. **A single top-level entry point doc** (README or SUMMARY) that ties together the now-many scattered docs (`FEASIBILITY_REPORT.md`, `VALIDATED_DESIGN_SCHEMA.md`, `ARCHITECTURE.md`, `CIRCUIT_DIAGRAM_APPROACH.md`, `MODIFICATION_SCHEMA.md`, `POC_RESULTS.md`) — someone new shouldn't have to read 70+ chronological decisions to understand what the system does and where to look for detail. Link out, don't duplicate.
3. **Updated `POC_RESULTS.md` as the definitive current-state summary**: what's proven (4/4 outputs, real formats, 32/63 real pins, DRC/validation coverage, versioning workflow), what's deferred by choice (remaining Group C mux-table pins, the upstream Hardware Agent selection bug — as the one-root-cause writeup, not six symptoms — cosmetic label collision, git cache history), and an explicit "don't claim more than this" boundary so a demo doesn't oversell POC-level work as production-ready.
4. **Decision log**: keep the full raw D-001…D-071+ log for audit purposes, but the summary doc should group/organize the load-bearing decisions by theme or phase rather than presenting a flat chronological list — use judgment on what's worth surfacing vs. what's detail only worth finding on request.
5. **`.env.example`** (no real values) so a handoff recipient knows what credentials are needed without reading source code to find every `process.env` reference.
6. **Revisit the deferred git cache-history bloat** (noted earlier as "before this repo goes public or gets other collaborators" — that condition is now true) — a clean history rewrite, or a documented decision not to bother, either is fine, but make it a decision rather than something left over by default.

**Definition of done:** fresh clean-state run passes; one clear entry-point doc exists; `POC_RESULTS.md` is current and honestly bounded; `.env.example` exists; the cache-history question is explicitly resolved one way or the other.


### Phase 10 — Async job pipeline (scoped, NOT started)
**Why this exists:** the HTTP job flow and the design pipeline are currently disconnected. `POST /api/jobs` runs `checkIntakeShape` → `buildValidatedDesign` → `Job.create` and stops. `buildValidatedDesign` and `resolveComponents` are otherwise called **only** from `scripts/` and tests, never from anything reachable by an HTTP request, and `scripts/run-poc.js` does not touch Mongo or the `Job` model at all. `JOB_STATUS` defines eight states; **only `received` is ever assigned** — there is no worker, queue, or service that advances a job.

**Consequence, and the specific reason this is scoped:** `Job.mockedPinCount` is permanently `null` ("not yet resolved") because populating it requires `resolveComponents()`, which is network-bound at seconds-to-minutes per part and therefore must not run in the request path. `compilable` *is* populated at intake, because `buildValidatedDesign` is pure, offline and deterministic. Closing that asymmetry is this phase's job.

**Scope:**
1. An async runner that advances `received → validating → resolving → compiling → generating → uploading → completed` (or `failed`), emitting the Socket.IO events per state that section 2 already requires for other agents' visibility.
2. Persist per-stage results onto the `Job`: resolution sources, `mockedPinCount` from `resolution.pins.perPin`, DRC summary, and the four output artifacts.
3. `mockedPinCount` becomes a real number. **`null` must continue to mean "not yet resolved" and must never be coerced to `0`** — an unknown rendering as a clean pass is the defect fixed in `MISSING_PINS` and in the false `real: true` bug (D-027).
4. Reuse `scripts/run-poc.js`'s existing pipeline rather than reimplementing it; the phases it runs are already proven end-to-end.

**Explicitly out of scope here:** component-ranking / coverage scoring, and the fab-action guard (D-078) — the latter attaches to a gerber-export or order-PCB route that does not exist yet, and is gated on this phase producing a real `mockedPinCount`.

**Definition of done:** uploading a fixture drives a job to `completed` without manual CLI steps; `mockedPinCount` is a real number on a finished job and `null` on an unprocessed one; the four outputs are populated from the async run; status events are emitted per transition.


### Phase 11 — Upstream retrieval/architecture mismatch (UPSTREAM, dunkai's repo — logged here, NOT started)

**This is not a ranking problem and ranking cannot solve it by construction.** Logged separately so it is never conflated with the `interface_match` aggregation fix, which is done and is a different defect at a different layer.

**The observation.** In `test-fixtures/dunkai_real_v3_rankedcoverage.json`, the architecture agent wired an I2C bus between U1 (MCU) and U2 (Power Management). U2's component request correctly carried `interfaces: ["I2C"]`. The retriever then returned a 20-candidate shortlist for U2 in which **zero candidates have I2C at all** — the shortlist was battery-protection ICs and linear chargers (HY21xx, AD405x family). Ranking's job is to order a shortlist; when no member of the shortlist can satisfy a required interface, the best possible ordering still yields an unbuildable net. This surfaced downstream as two `PART_CAPABILITY_MISMATCH` errors on U2.

**Why it is genuinely upstream.** Two candidate root causes, both above ranking:
1. The architecture agent requested a bus from a subsystem that does not typically expose one ("Power Management" as a plain linear regulator / protection IC), i.e. the *requirement* is wrong.
2. Retrieval resolved the subsystem to a taxonomy (`literal category match 'power'`) that structurally cannot contain an I2C-capable PMIC, i.e. the *candidate set* is wrong.

Distinguishing these needs upstream instrumentation, not a scoring change.

**Scope when picked up (all in dunkai, none in this repo):**
1. Detect the condition rather than let it pass silently: if no candidate in a shortlist has positive evidence for a required interface, that is a reportable retrieval failure, not a ranking outcome. It currently produces a confident winner with no warning.
2. Decide the correct response — re-query with an interface-constrained taxonomy, or feed the gap back to the architecture agent to drop the bus.
3. Keep the three-state discipline: "no candidate confirms I2C" is only actionable where the shortlist has real coverage data. With a table at 44% complete-naming, absence of confirmation is mostly still *unknown*.

**Explicitly NOT in scope:** anything in `ranking.py`. The aggregation defect (a verified absence being averaged away by a confirmed interface) is fixed and regression-tested as `verified-absence-outranking-unknown`; this item is what remains after that fix, and the open question is whether it dominates the Phase 5 error count regardless of ranking quality.


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

- [x] Phase 1 — Repo & job skeleton
- [x] Phase 2 — tscircuit feasibility report
- [x] Phase 3 — ValidatedDesign schema
- [x] Phase 4 — Architecture doc
- [x] Phase 5 — Minimal POC (real-first resolution: rc_car.json + smart_dustbin.json end-to-end, 18/19 parts resolved for real; validator proven against noise_pollution_monitor.json, all 4 known bugs + 5th I2C SCL↔SDA bug + PIN_IN_MULTIPLE_NETS bug caught)
- [x] Phase 5.5 — DRC wired in
- [x] Phase 5.6 — Resolution-integrity fixes (false real:true bug, false determinism/no-cache bug)
- [ ] Phase 6 — Pin-name resolution (Group A done; pilot proven twice — LP103SB6F.GND and HY2111-GB both confirmed in curatedPinouts.js; Group B/rest of Group C on hold pending scope-expansion decision)
- [x] Phase 7 — Stylized icon-based circuit diagram (done, verified — connectivity algorithm unchanged, geometry constants updated for icon fit)
- [x] Phase 6.5 — Catalogue/cache-completeness audit (done — 3D-model discard bug found/fixed, LP103SB6F cross-validated, systemic upstream capability-mismatch pattern discovered across 5 parts)
- [x] Phase 6.6 — Capability-mismatch validation (done — PART_CAPABILITY_MISMATCH implemented, 3 guards, 5 pins/4 parts reclassified, systemic upstream finding documented)
- [x] Phase 8 — Conversational modification workflow (done — real end-to-end success and DRC-block both proven; semantic target-mismatch check added and proven with a forced real misidentification; known limitation: fixed English vocabulary, correctly returns `unverifiable` rather than false-alarming on unusual phrasing)
- [ ] Phase 10 — Async job pipeline (scoped, not started — job flow and design pipeline are disconnected; only `received` is ever assigned)
- [x] Phase 9 — Consolidation for handoff/demo (done — cold-state verification run surfaced two previously-unseen defects in `noise_pollution_monitor` (U4 catalogue gap → 16/19 routed; through-hole gerber export failure) and corrected an overclaimed determinism guarantee (D-074); README rewritten as entry point, POC_RESULTS.md now the definitive current-state summary with an explicit "does NOT claim" boundary, `.env.example` added, cache-history rewrite explicitly declined (D-075))
