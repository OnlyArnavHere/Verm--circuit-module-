# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

Downstream module of an already-built Hardware Agent (**do not touch or rebuild
that**). Consumes its JSON output and produces four real exportable files:
circuit diagram, schematic, PCB layout, 3D view.

`PROJECT_PLAN.md` is the source of truth for scope and phase order. Work phase by
phase; don't skip ahead. `DECISIONS.md` records every non-trivial choice — keep it
updated.

**Current status: Phases 1–5 complete — stop for checkpoint review before Phase 6.**
Read `docs/FEASIBILITY_REPORT.md` before doing any tscircuit work — it is
empirically verified, and several of its findings constrain the design.

## Commands

All server commands run from `server/`; frontend from `web/`.

```bash
docker compose up -d          # MongoDB :27017, MinIO :9100 (console :9101)

cd server
npm run dev                   # API + Socket.IO :4000, with --watch
npm start
npm run storage:healthcheck   # object storage write/read/verify/delete
npm run verify:phase1         # Phase 1 definition-of-done (needs server running)
npm test                      # node --test (unit tests, no services needed)

cd web
npm run dev                   # dev upload UI :5173
npm run build
```

Test runner is Node's built-in `node --test`. Note: passing a path argument
(`node --test test/`) fails on Node 26 with MODULE_NOT_FOUND — let it auto-discover.
To run a single test, use `node --test --test-name-pattern "duplicate ref_ids"`.

## Architecture

The rule that overrides every other design decision:

```
LLM Agent → Validated Design Spec → Deterministic Compiler → tscircuit → Artifacts
```

The LLM interprets and plans. It **never** emits final PCB/schematic geometry that
gets trusted blindly. The compiler is deterministic: same `ValidatedDesign` + same
compiler version + same component library → identical output. Keep these three
layers structurally separate. If you're about to have the agent generate tscircuit
code and just run it — stop, and route it through validation first.

### Layer boundaries that matter

- **`server/src/upstream/intakeCheck.js` is NOT the design validator.** It answers
  only "is this shaped like a Hardware Agent document?" Electrical correctness,
  net de-duplication, protocol checks, and pin resolution belong to the
  deterministic validation layer (Phases 3–5). Do not grow intakeCheck into it.
  A malformed *structure* is an intake failure; a wrong *design* is a validation
  failure. These must stay distinguishable.
- **`Job.outputs`** has exactly four slots (`circuit`, `schematic`, `pcb`,
  `model3d`), present and null from creation. An output only counts when it is a
  **real file** in object storage — a live browser render is not a deliverable.
- **`Job.modifications`** exists because corrections are never silent. Any time
  the validator "fixes" upstream data (e.g. the SCK↔MOSI bug), record the original
  value, the correction, and the reason.
- Field is **`validationErrors`**, not `errors` — Mongoose reserves `errors`.

## tscircuit facts established in Phase 2 (verified, not assumed)

All four required outputs export to real files headlessly and offline — confirmed
in `node:22-slim` with `--network none`. No headless-browser screenshotting needed.

```
eval:      @tscircuit/eval CircuitRunner -> execute() -> renderUntilSettled() -> getCircuitJson()
circuit:   convertCircuitJsonToSchematicSvg (circuit-to-svg) + readable-netlist
schematic: convertCircuitJsonToSchematicSvg, or CircuitJsonToKicadSchConverter -> .kicad_sch
pcb:       CircuitJsonToKicadPcbConverter -> .kicad_pcb; convertSoupToGerberCommands -> gerbers
3d:        convertCircuitJsonToGltf(cj, {format:"glb"}) -> real .glb
drc:       @tscircuit/checks runAllChecks / runAllRoutingChecks / runAllPlacementChecks
```

Three findings that **must** shape any code you write here:

1. **A clean tscircuit run is not proof of a valid board.** `DFN-8-EP(2x3)`
   produces zero errors, zero warnings, and **zero pads**. Always independently
   assert `pad_count > 0` per component and that it matches the resolved pin count.
   Never treat "no `*_error` elements" as success. (DECISIONS D-009)
2. **Fixture `package` strings are not tscircuit footprints.** 8 of 10 are
   rejected outright. A resolution layer is required, and when it can't resolve
   confidently the answer is `FOOTPRINT_NOT_FOUND` — never a similar-looking
   substitute. (D-010)
3. **`jlcpcb:` lookups hit the network** (1.8–4.2 s/part) and can change upstream.
   Cache resolved footprints by part number so re-runs stay deterministic and
   offline. (D-011)

Determinism: rendered artifacts are byte-identical across runs *and across
macOS/Linux*. The only varying Circuit JSON field is an instance counter inside a
warning message string — normalize `#\d+` before hashing. Pin exact versions; every
tscircuit package is pre-1.0. Re-run `spikes/phase2-tscircuit/` as an upgrade gate.

## Phase 3 layer (`server/src/design/`, `server/src/render/`)

```
design/validatedDesign.js  buildValidatedDesign(upstream) -> {design, errors, modifications, compilable}
design/footprintMap.js     resolveFootprint(pkg) -> verified footprint | FOOTPRINT_NOT_FOUND
design/tscircuitErrors.js  collectTscircuitIssues(circuitJson) -> our taxonomy
design/assertions.js       assertPadIntegrity / assertNetsRealized  <- catches the silent zero-pad case
render/circuitDiagram.js   renderCircuitDiagram(design) -> SVG (required output #1)
render/symbolAdapter.js    schematic-symbols -> SVG fragments
```

Rules that are easy to "helpfully" break:

- **Never add a footprint mapping without evidence.** Matching pad count is not
  matching geometry (D-016). Unverified candidates belong in
  `UNVERIFIED_CANDIDATES` with a `blocker`, never in `CURATED`.
- **`compilable` is computed from the error list**, never assumed from silence.
- **The circuit diagram is defined by what it omits** (D-015) — only pins in a
  net, grounds as symbols, power as one rail. If it starts showing every pin it
  has become the schematic and no longer satisfies output #1.
- **`source` on every resolved value** distinguishes verified data from a mock.
  A mock must be labelled `source: "mock"`; `unresolved` must never reach the compiler.
- `server/test/fixtures/circuitjson-*.json` are **real captured tscircuit output**
  (D-019). Regenerate from the Phase 2 spike after a tscircuit upgrade; don't hand-edit.

## Phase 5 pipeline (`server/src/design/`, `server/src/compile/`)

```
scripts/run-poc.js  parse -> electrical checks -> dedupe -> resolve -> compile -> S3 -> manifest
design/partsEngine.js  MPN -> LCSC via jlcsearch, package-matched, disk-cached
design/pinout.js       real pin NAMES from catalogue footprints, disk-cached
design/resolver.js     per-field real/mock resolution
design/electricalChecks.js  the 4 known bugs
compile/toTscircuit.js compiles to tscircuit source
compile/compile.js     -> the 4 required output files
```

Constraints learned the hard way — do not undo:

- **Never set `pinLabels` on a `<chip>`.** It silently prevents ALL PCB routing
  (`pcb_trace_missing_error` for every connection). Route on pad selectors
  (`.U1 > .pin3`). (D-024)
- **`assertNetsRealized` counts connections, not nets.** `traceCount > 0` would
  pass a board with 1 of 5 nets routed — that's the bug it caught. (D-025)
- **Never borrow pin names across footprints.** Pad numbering belongs to the
  footprint actually compiled; names from a different one can mis-map pads. (D-023)
- **Parts-engine hits require an exact package-string match.** A part-number hit
  with a different package is a rejection, not a warning. (D-021)
- `server/data/*-cache.json` and `server/data/http-cache/` are committed so
  re-runs are deterministic and offline. Delete to re-fetch.
- **A `real` claim may only be made from compiled ground truth** (D-027). Never
  infer one field's provenance from another's. An unread flag is worse than no
  flag — that's what caused the false `model_3d.real = true`.
- **Never cache a failed HTTP response** (D-028) — it pins a transient outage
  permanently. A real 504 from the parts service is covered by a test.
- **Curated pinouts are keyed by part number, not package** (D-030), and each
  entry needs `evidence` that pad numbering corresponds to the compiled footprint.
- `runDrc` must `await` — `runAllChecks` is async, and an unawaited call inspects
  as an empty result, silently reporting "no DRC findings" for every board.
- Determinism is **per-mode**: offline↔offline and online↔online are
  byte-identical; online↔offline are not (D-029). Don't claim more than that.

## Failure handling (non-negotiable)

Fail explicitly, never silently, never by guessing. Error codes live in
`server/src/models/constants.js`:

```
COMPONENT_NOT_FOUND, PIN_NOT_FOUND, FOOTPRINT_NOT_FOUND, MODEL_3D_NOT_FOUND,
INVALID_NET, ELECTRICAL_CONFLICT, UNSUPPORTED_COMPONENT, ROUTING_FAILURE,
DRC_FAILURE, BOARD_CONSTRAINT_FAILURE
```

Plus intake-level `MALFORMED_UPLOAD` and `UNSUPPORTED_SCHEMA_VERSION`.

Never claim a design is valid when critical validation failed. Never hallucinate a
pinout, footprint, or 3D model for a part you can't verify — return a structured
error. When something is mocked, label it (`mocked: true` + `mockReason`).

## Test fixtures contain known bugs — on purpose

`test-fixtures/` holds four Hardware Agent outputs. Treat upstream nets as
**claims to verify**, not ground truth. The validator must catch these:

| File | Net(s) | Bug |
|---|---|---|
| `smart_dustbin.json` | `SPI_10` | `U7.SCK` tied to `U1.MOSI` — clock to data pin |
| `noise_pollution_monitor.json` | `SPI_8`, `SPI_10` | Same SCK↔MOSI pattern, twice |
| `noise_pollution_monitor.json` | `I2C_7`, `I2C_11` | Both end at `U1.SDA`, never join SCL — one bus modeled as two disconnected half-nets |
| `smart_dustbin.json`, `noise_pollution_monitor.json` | `POWER_1..N` | Redundant; `POWER_RAIL_3V3` already covers them |

These files **upload successfully in Phase 1** — that's correct, they're
structurally valid. Catching them is Phase 3–5 work.

**Their pin names are fabricated — see D-076 before trusting any of them.** The
upstream net-builder derives pin names from interface type, not from the selected
part (its dataset has zero pinout rows), so all four bugs above are deterministic
outputs of one function rather than incidental data errors. Consequences:

- These fixtures are valid for intake, de-duplication, error paths, and
  determinism. They are **not** evidence of electrical correctness.
- **A dunkai design reaching `compilable: true` is a false pass, not a
  milestone** — same shape as the zero-pad case (D-009) and the false
  `real:true` bug: the check passes because the input is meaningless.
- The 32/63 real-pin count is an **upper bound**. A fabricated `SDA` that lands
  on a footprint genuinely exposing `SDA` is indistinguishable here from a
  correct mapping.
- Do **not** relax `FOOTPRINT_NOT_FOUND`, `PIN_NOT_FOUND`, or `compilable:
  false` to make dunkai output compile. That conservatism is what is currently
  protecting this repo.

`rc_car.json` is the simplest (3 components) — use it for the first POC.
`noise_pollution_monitor.json` is the most complex — use it to prove the validator.

## Storage

Dev uses a local **MinIO** container, not AWS S3 (see DECISIONS.md D-002). Code
targets the S3 API via `@aws-sdk/client-s3`, so switching to real AWS is a `.env`
change: clear `S3_ENDPOINT`, set `S3_FORCE_PATH_STYLE=false`, supply real keys.

Ports are 9100/9101, not the MinIO defaults — an unrelated pre-existing project on
this machine holds 9000/9001. Leave that stack alone.

## Working rules

- Commit after each phase, message referencing the phase.
- Update `DECISIONS.md` for any deviation from the plan's stack or upstream contract.
- Prioritize Phase 2 accuracy over speed. An honest "tscircuit can't do X" on day 1
  is far cheaper than discovering it on day 20. Research the **current** tscircuit
  ecosystem from its real repos/docs — do not rely on training knowledge.
