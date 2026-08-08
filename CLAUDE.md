# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

Downstream module of an already-built Hardware Agent (**do not touch or rebuild
that**). Consumes its JSON output and produces four real exportable files:
circuit diagram, schematic, PCB layout, 3D view.

`PROJECT_PLAN.md` is the source of truth for scope and phase order. Work phase by
phase; don't skip ahead. `DECISIONS.md` records every non-trivial choice — keep it
updated.

**Current status: Phase 1 complete.** Phase 2 (tscircuit feasibility) is next.

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

`test-fixtures/` holds four real Hardware Agent outputs. Treat upstream nets as
**claims to verify**, not ground truth. The validator must catch these:

| File | Net(s) | Bug |
|---|---|---|
| `smart_dustbin.json` | `SPI_10` | `U7.SCK` tied to `U1.MOSI` — clock to data pin |
| `noise_pollution_monitor.json` | `SPI_8`, `SPI_10` | Same SCK↔MOSI pattern, twice |
| `noise_pollution_monitor.json` | `I2C_7`, `I2C_11` | Both end at `U1.SDA`, never join SCL — one bus modeled as two disconnected half-nets |
| `smart_dustbin.json`, `noise_pollution_monitor.json` | `POWER_1..N` | Redundant; `POWER_RAIL_3V3` already covers them |

These files **upload successfully in Phase 1** — that's correct, they're
structurally valid. Catching them is Phase 3–5 work.

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
