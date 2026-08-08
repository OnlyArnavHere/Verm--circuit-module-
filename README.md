# PCB & Circuit Design Agent

Downstream of an already-built Hardware Agent. Takes its JSON output and produces
four real, exportable files: circuit diagram, schematic, PCB layout, and 3D view.

See [PROJECT_PLAN.md](PROJECT_PLAN.md) for the full plan and
[DECISIONS.md](DECISIONS.md) for choices made along the way.

**Current status: Phase 1 complete (plumbing only).** Uploads create job records
and emit events. No design generation runs yet.

## Architecture rule

```
LLM Agent → Validated Design Spec → Deterministic Compiler → tscircuit → Artifacts
```

The LLM interprets and plans; it never emits final geometry that gets trusted
blindly. The compiler is deterministic. These three layers stay structurally
separate in the codebase.

## Prerequisites

- Node 22+ (developed on 26.7.0)
- Docker (for MongoDB + MinIO)

## Setup

```bash
cp .env.example .env
docker compose up -d          # MongoDB :27017, MinIO :9100 (console :9101)

cd server && npm install
cd ../web && npm install
```

## Run

```bash
cd server && npm run dev      # API + Socket.IO on :4000
cd web    && npm run dev      # dev upload UI on :5173
```

Then open http://localhost:5173 and upload any file from `test-fixtures/`.

## Verify

```bash
cd server
npm run storage:healthcheck   # object storage write/read/verify/delete
npm run verify:phase1         # full Phase 1 definition-of-done (server must be running)
```

`verify:phase1` checks that all four fixtures upload and persist, that each emits
a `job:received` socket event, that malformed input is rejected without creating a
job, and that storage round-trips a real file.

## API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Live MongoDB + storage state |
| `POST` | `/api/jobs` | Upload a Hardware Agent JSON (multipart field `design`, or a raw JSON body) |
| `GET` | `/api/jobs` | List jobs, newest first (`?status=`, `?limit=`) |
| `GET` | `/api/jobs/:jobId` | One job |
| `GET` | `/api/jobs/:jobId/upstream` | The verbatim upstream payload |
| `GET` | `/api/jobs/:jobId/outputs/:kind/url` | Presigned artifact link (409 until Phase 5) |

### Socket.IO events

Clients auto-join the `jobs` firehose; send `job:subscribe` with a job ID for a
per-job stream. Events: `job:received` (live now), plus `job:status`,
`job:completed`, `job:failed` reserved for later phases.

## Layout

```
server/
  src/
    upstream/intakeCheck.js   structural intake check ONLY — not the design validator
    models/Job.js             job record; `outputs` holds the 4 required artifacts
    models/constants.js       status, output kinds, error taxonomy
    services/storage.js       S3-compatible storage (MinIO in dev, AWS S3 later)
    services/events.js        Socket.IO fan-out
    routes/jobs.js            intake + read API
  scripts/                    healthcheck + phase verification
web/                          dev-only upload UI (temporary, no auth)
test-fixtures/                4 real Hardware Agent outputs
```

## Storage note

Phase 1 uses a **local MinIO** container, not AWS S3 — see DECISIONS.md D-002.
The code targets the S3 API, so moving to real AWS S3 is a `.env` change, not a
code change.
