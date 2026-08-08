# DECISIONS

Every non-trivial choice made without asking, especially deviations from
`PROJECT_PLAN.md` section 2 (stack) or section 1 (upstream contract).

---

## D-001 — Node 26 installed via Homebrew; npm workspaces not used

**Phase:** 1
**Status:** Accepted

The machine had no Node runtime at all. Installed Node v26.7.0 / npm 11.19.0 via
Homebrew. `server/` and `web/` are two independent npm packages with their own
lockfiles rather than a workspace monorepo — the two halves have disjoint
dependency trees, and `web/` is explicitly temporary/dev-only per section 2, so
coupling them through a shared root package.json buys nothing.

---

## D-002 — Local MinIO instead of AWS S3 for Phase 1 (deviation from section 2)

**Phase:** 1
**Status:** Accepted — revisit before production

Section 2 says "AWS S3 (already set up)". That turned out not to hold for this
project: the AWS account reachable from this machine (`pcb-agent-dev`) belongs to
a **prior, separate project**, which used a self-hosted MinIO container for local
dev. Per explicit instruction, this build stands up its **own** MinIO service with
its own bucket and credentials rather than reusing anything from that project.

Consequences:

- The storage layer is written against the S3 API (`@aws-sdk/client-s3`), not
  against MinIO. Switching to real AWS S3 is a config change only: clear
  `S3_ENDPOINT`, set `S3_FORCE_PATH_STYLE=false`, supply real keys. No code change.
- The section 2 note about the 6-month S3 free-tier expiry being a risk is
  **moot for now** — there is no AWS dependency in Phase 1. It becomes live again
  if and when production moves to real S3. Flag it then, not in the Phase 2
  feasibility report.
- Host ports are **9100/9101**, not MinIO's default 9000/9001: the prior project's
  stack (`pcb-agent-minio-1`) already holds 9000/9001 on this machine. That stack
  is left running and untouched.

---

## D-003 — Job intake stops at `received`; no generation pipeline wired

**Phase:** 1
**Status:** Accepted

Phase 1 is plumbing only per its Definition of Done. `POST /api/jobs` validates
*structure*, persists, emits `job:received`, and stops. No queue/worker is
introduced yet — picking a job-runner belongs with Phase 2's findings about how
tscircuit actually has to be executed (in-process vs. containerized), and choosing
one now would likely be wrong.

---

## D-004 — Intake shape-check kept strictly separate from the design validator

**Phase:** 1
**Status:** Accepted

`server/src/upstream/intakeCheck.js` answers only "is this shaped like a Hardware
Agent document?" It deliberately does **not** check electrical correctness.

The known-bad fixture data (SCK↔MOSI, split I2C half-nets, redundant POWER_N nets)
**uploads successfully in Phase 1, and that is correct behaviour** — those are
design-validation failures owned by the deterministic layer in Phases 3–5, not
malformed input. Conflating the two would make it impossible to tell "the Hardware
Agent sent garbage" from "the Hardware Agent sent a well-formed but electrically
wrong design", which are different failures with different responses.

The file carries a comment saying so, to stop it from quietly growing into the
real validator.

---

## D-005 — Job field named `validationErrors`, not `errors`

**Phase:** 1
**Status:** Accepted

Mongoose reserves `errors` on documents for its own validation state; using it as
a schema path emits a reserved-key warning and can break document behaviour. The
error-taxonomy array is therefore stored and exposed as `validationErrors`. Error
**code** values are exactly as specified in section 4 — only the container field
was renamed.

---

## D-006 — Two intake-level error codes added outside the section 4 taxonomy

**Phase:** 1
**Status:** Accepted

Section 4's ten codes all describe *design* failures. Intake needs to reject
things that never get far enough to be a design — unparseable JSON, a missing
`components` array, an unknown `schema_version`. Added `MALFORMED_UPLOAD` and
`UNSUPPORTED_SCHEMA_VERSION` for that, kept visibly separate in
`server/src/models/constants.js`. The ten design codes are untouched.

---

## D-007 — Socket events fan out to a firehose room as well as a per-job room

**Phase:** 1
**Status:** Accepted

Section 2 requires other platform agents to have visibility. Every event is
emitted to both `job:<jobId>` (for a UI watching one job) and a global `jobs` room
(for agents watching all activity), so a background agent doesn't need to know job
IDs in advance to observe the system. Socket delivery is best-effort; MongoDB
remains the durable record, so an agent that was offline can still read state.
