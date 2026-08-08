# PROJECT PLAN — PCB & Circuit Design Agent

**Status:** Phase 1 complete. Phase 2 (tscircuit feasibility) is next.
**Owner of execution:** Claude Code, working phase by phase from this document.
**Do not skip ahead.** Each phase ends with a checkpoint deliverable. Do not start the next phase until the current one's deliverable exists and is checked off below.

---

## 0. What this system is

Downstream of an **already-built Hardware Agent** (do not touch it, do not rebuild it), this module takes its JSON output and produces exactly these four outputs, **each as a real exportable file, not just an in-session render**:

1. **Circuit diagram** — component-to-component wiring/connectivity view → file (e.g. SVG/PNG)
2. **Schematic diagram** — proper electrical schematic capture → file (e.g. SVG/PNG, ideally also a structured format like KiCad `.sch`/`.kicad_sch` if tscircuit supports it)
3. **PCB layout** — physical board with footprints, placement, traces, layers → file (e.g. KiCad `.kicad_pcb` and/or Gerber set)
4. **PCB 3D view** — rendered/interactive 3D representation → file (e.g. `.glb`/`.gltf` or STEP)

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

### Phase 3 — `ValidatedDesign` intermediate schema
Design the schema that sits between the agent and the compiler — independent enough of tscircuit that it could be swapped later. Must represent: resolved components (symbol/footprint/3D refs, resolved physical pins), resolved nets (physical pads, de-duplicated), board constraints.
**Definition of done:** `docs/VALIDATED_DESIGN_SCHEMA.md` with the schema and rationale, validated by hand against `rc_car.json`.

### Phase 4 — Agent vs. deterministic-layer architecture
Document concretely: what the LLM agent layer owns (interpretation, component-resolution decisions, ambiguity handling, explaining errors, modification requests) vs. what the deterministic layer owns (schema validation, pin mapping, connectivity/protocol validation, footprint assignment, routing, DRC, artifact generation). Include the explicit error taxonomy: `COMPONENT_NOT_FOUND`, `PIN_NOT_FOUND`, `FOOTPRINT_NOT_FOUND`, `MODEL_3D_NOT_FOUND`, `INVALID_NET`, `ELECTRICAL_CONFLICT`, `UNSUPPORTED_COMPONENT`, `ROUTING_FAILURE`, `DRC_FAILURE`, `BOARD_CONSTRAINT_FAILURE` — what triggers each, what the response shape looks like.
**Definition of done:** `docs/ARCHITECTURE.md`.

### Phase 5 — Minimal end-to-end POC
Push `rc_car.json` through: parse → resolve components (mock clearly where real footprint/3D data isn't available — label every mock explicitly) → validate → compile → tscircuit → **produce actual files on disk (and uploaded to S3) for all 4 outputs — circuit diagram, schematic, PCB layout, 3D view.** If Phase 2 found a given output needs a conversion step to become a real file, that conversion step must actually run here, not be deferred. Partial/stubbed content inside a file is acceptable (e.g. a minimal placeholder PCB layout) as long as it's honestly labeled — an output that only exists as a live render and never became a file is not acceptable and counts as phase-incomplete. Separately, run the validator against `noise_pollution_monitor.json` and confirm it actually catches all four known bugs from section 1's table.
**Definition of done:** working code in the repo, all 4 output files present on disk/S3 with a manifest listing each file's path and format, plus `docs/POC_RESULTS.md` stating exactly what worked, what was mocked, what failed and why, and confirmation the 4 known bugs were caught.

**Stop after Phase 5** for a review checkpoint before touching full component-database integration, full routing/DRC, or production hardening.

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

- [x] Phase 1 — Repo & job skeleton *(verified: `cd server && npm run verify:phase1` → 8/8)*
- [ ] Phase 2 — tscircuit feasibility report
- [ ] Phase 3 — ValidatedDesign schema
- [ ] Phase 4 — Architecture doc
- [ ] Phase 5 — Minimal POC (rc_car.json end-to-end + validator proven against noise_pollution_monitor.json)
