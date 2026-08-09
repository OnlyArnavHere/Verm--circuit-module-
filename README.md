# PCB & Circuit Design Agent

Downstream module of an already-built Hardware Agent. Takes its JSON output and
produces **four real, exportable files** — circuit diagram, schematic, PCB
layout, and 3D view — plus conversational repositioning with versioned history.

> **Status: all phases complete (1–9). POC-verified, not production-ready.**
> Read [docs/POC_RESULTS.md § What this does NOT claim](docs/POC_RESULTS.md#what-this-does-not-claim)
> before showing this to anyone. One of the four fixtures does not fully route,
> by a known and diagnosed cause.

## The rule that overrides every other design decision

```
LLM Agent → Validated Design Spec → Deterministic Compiler → tscircuit → Artifacts
```

The LLM interprets and plans. It **never** emits final PCB/schematic geometry
that gets trusted blindly. Same `ValidatedDesign` + same compiler version + same
component library → identical geometry. These three layers stay structurally
separate in the codebase, and everything else here follows from that.

Two corollaries worth knowing before reading any code:

- **Failure is explicit.** No silent guessing. An unresolvable footprint is
  `FOOTPRINT_NOT_FOUND`, never a lookalike substitute. Anything mocked is
  labelled `source: "mock"` per field.
- **A clean tscircuit run is not proof of a valid board.** It will happily
  produce a component with zero pads and report no errors. Independent
  assertions exist for exactly this.

---

## Where to look

| If you want to know… | Read |
|---|---|
| **What actually works today, and what it must not be claimed to do** | [docs/POC_RESULTS.md](docs/POC_RESULTS.md) |
| Whether tscircuit can really export these formats headlessly | [docs/FEASIBILITY_REPORT.md](docs/FEASIBILITY_REPORT.md) |
| The layer boundaries, data flow, and error taxonomy | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| The `ValidatedDesign` contract and per-field provenance | [docs/VALIDATED_DESIGN_SCHEMA.md](docs/VALIDATED_DESIGN_SCHEMA.md) |
| Why the circuit diagram is drawn by hand rather than exported | [docs/CIRCUIT_DIAGRAM_APPROACH.md](docs/CIRCUIT_DIAGRAM_APPROACH.md) |
| How natural-language edits become versioned boards | [docs/MODIFICATION_SCHEMA.md](docs/MODIFICATION_SCHEMA.md) |
| Scope and phase order (source of truth) | [PROJECT_PLAN.md](PROJECT_PLAN.md) |
| Why any individual choice was made | [DECISIONS.md](DECISIONS.md) — 75 entries, chronological |

**Start with `POC_RESULTS.md`.** It is the current-state summary; the rest is
detail behind it.

---

## The load-bearing decisions

`DECISIONS.md` is a chronological audit log, which is the wrong shape for
learning the system. These are the ones that constrain how you can change the
code, grouped by what they protect.

### Never guess — the failure-handling spine

| | |
|---|---|
| [D-010](DECISIONS.md) | An unresolvable package is `FOOTPRINT_NOT_FOUND`, never a similar-looking substitute. |
| [D-016](DECISIONS.md) | Matching pad count is **not** matching geometry. No footprint mapping without evidence. |
| [D-023](DECISIONS.md) | Never borrow pin names across footprints — pad numbering belongs to the footprint compiled. |
| [D-027](DECISIONS.md) | A `real` claim may only be made from compiled ground truth, never inferred from another field. |
| [D-064](DECISIONS.md) | `PART_CAPABILITY_MISMATCH` — asserting a part *cannot* do something needs stronger evidence than failing to find it. |

### Verify, don't trust the tool

| | |
|---|---|
| [D-009](DECISIONS.md) | Zero errors ≠ valid board. `DFN-8-EP(2x3)` compiles clean with **zero pads**. Always assert pad count independently. |
| [D-024](DECISIONS.md) | Never set `pinLabels` on a `<chip>` — it silently kills **all** PCB routing. Route on pad selectors. |
| [D-025](DECISIONS.md) | `assertNetsRealized` counts *connections*, not nets. `traceCount > 0` would pass a board with 1 of 5 nets routed. |
| [D-068](DECISIONS.md) | The cheap overlap pre-check is a guard, never a substitute for the real DRC re-run. |
| [D-071](DECISIONS.md) | DRC cannot see a **wrong target**: moving the wrong component passes every geometric check. |

### Determinism and provenance

| | |
|---|---|
| [D-011](DECISIONS.md) | Cache resolved footprints by part number — `jlcpcb:` lookups hit the network and can change upstream. |
| [D-028](DECISIONS.md) | Never cache a failed HTTP response; it pins a transient outage permanently. |
| [D-029](DECISIONS.md), [D-074](DECISIONS.md) | Determinism is **geometry-level, per-mode** — embedded timestamps and UUIDs vary between runs. |
| [D-061](DECISIONS.md) | A part-specific footprint outranks a package-generic one. |

### Layer boundaries

| | |
|---|---|
| [D-005](DECISIONS.md) | Mongoose reserves `errors` — the field is `validationErrors`. |
| [D-015](DECISIONS.md) | The circuit diagram is defined by what it **omits**. If it shows every pin it has become the schematic. |
| [D-067](DECISIONS.md) | Placement is explicit `ValidatedDesign` state, not something the compiler derives. |
| [D-070](DECISIONS.md) | Request interpretation is single-extractor — unlike Phase 6, because DRC independently checks the result. |

---

## Prerequisites

- Node 22+ (developed on 26.7.0)
- Docker (MongoDB + MinIO)

## Setup

```bash
cp .env.example .env          # only MONGO_URI and S3_BUCKET are required
docker compose up -d          # MongoDB :27017, MinIO :9100 (console :9101)

cd server && npm install
cd ../web && npm install
```

Ports are **9100/9101**, not MinIO's usual 9000/9001 — an unrelated project on
the original machine held those (D-002).

## Run the pipeline

```bash
cd server
node scripts/run-poc.js                                  # rc_car + smart_dustbin
node scripts/run-poc.js rc_car smart_dustbin gas_leakage_detector noise_pollution_monitor
node scripts/run-poc.js --offline --no-upload            # zero network calls
```

Artifacts land in `artifacts/<fixture>/` and upload to S3 unless `--no-upload`.

### First run is a cold start

The component-data cache (footprint geometry + 3D models, ~18 MB) is **not
committed**. The first online run fetches and caches it — about 70 network calls.
After that `--offline` works with the network blocked: the cache goes readonly
and any uncached request throws rather than silently fetching.

## Modify a board conversationally

```bash
node scripts/run-modification.js smart_dustbin "move U6 2mm to the right"
node scripts/run-modification.js smart_dustbin --instruction '{"type":"REPOSITION_COMPONENT",...}'
```

A rejected move creates **no version** and leaves v1 byte-identical. The
`--instruction` form skips the LLM entirely, so no API key is needed.

## Development

```bash
cd server
npm run dev                   # API + Socket.IO :4000
npm test                      # 176 tests, no services needed
npm run storage:healthcheck   # object storage write/read/verify/delete
npm run verify:phase1         # intake definition-of-done (server must be running)

cd web && npm run dev         # upload UI :5173
```

Test runner is Node's built-in `node --test`. Passing a path (`node --test test/`)
fails on Node 26 with `MODULE_NOT_FOUND` — let it auto-discover. Single test:
`node --test --test-name-pattern "duplicate ref_ids"`.

## API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Live MongoDB + storage state |
| `POST` | `/api/jobs` | Upload Hardware Agent JSON (multipart field `design`, or raw JSON body) |
| `GET` | `/api/jobs` | List jobs, newest first (`?status=`, `?limit=`) |
| `GET` | `/api/jobs/:jobId` | One job |
| `GET` | `/api/jobs/:jobId/upstream` | The verbatim upstream payload |
| `GET` | `/api/jobs/:jobId/outputs/:kind/url` | Presigned artifact link |

Socket.IO: clients auto-join the `jobs` firehose; `job:subscribe` with a job ID
gives a per-job stream.

## Layout

```
server/src/
  upstream/intakeCheck.js    structural intake ONLY — not the design validator
  design/
    validatedDesign.js       buildValidatedDesign(upstream) -> design/errors/modifications
    electricalChecks.js      the four known upstream bugs
    footprintMap.js          resolveFootprint(pkg) -> verified footprint | FOOTPRINT_NOT_FOUND
    partsEngine.js           MPN -> LCSC, package-matched, disk-cached
    pinout.js                real pin NAMES from catalogue footprints
    resolver.js              per-field real/mock resolution with provenance
    assertions.js            pad integrity + nets realized — catches silent zero-pad
    placement.js             placement as explicit state (Phase 8)
    modification.js          deterministic repositioning transform
    targetCheck.js           semantic "did we move the right part" check
    drc.js                   @tscircuit/checks wrapper (MUST be awaited)
  compile/
    toTscircuit.js           ValidatedDesign -> tscircuit source
    compile.js               -> the four required output files
  render/circuitDiagram.js   stylized circuit diagram (required output #1)
scripts/                     POC runner, modification runner, verifiers, audits
test-fixtures/               4 real Hardware Agent outputs — they contain real bugs on purpose
```

### The fixtures contain known bugs deliberately

Upstream nets are **claims to verify**, not ground truth. All four bugs are
caught — see [docs/POC_RESULTS.md](docs/POC_RESULTS.md#the-four-known-bugs--all-caught).
`rc_car.json` is the simplest (3 components); `noise_pollution_monitor.json` is
the hardest and is the one that exercises the failure paths.
