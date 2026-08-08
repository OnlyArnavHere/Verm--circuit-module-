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

---

## D-008 — Phase 2 verified empirically, not just from docs

**Phase:** 2
**Status:** Accepted

The plan warns against relying on stale training knowledge about tscircuit. Rather
than trusting docs alone, Phase 2 shipped a runnable spike
(`spikes/phase2-tscircuit/`) that actually produces all four outputs and is
re-runnable as an upgrade gate. Docs answered *what should exist*; the spike
answered *what actually happens* — and the two diverged in ways that matter
(see D-009). The spike is throwaway research code, deliberately kept out of
`server/`.

---

## D-009 — Our compiler must assert pad counts; a clean tscircuit run is not proof

**Phase:** 2
**Status:** Accepted — binding constraint on Phase 3/5

Empirically, `footprint="DFN-8-EP(2x3)"` yields **zero errors, zero warnings, and
zero pads**, while still emitting component, silkscreen, and courtyard geometry.
tscircuit reports success; the board is unmanufacturable.

Therefore the deterministic layer must **never** treat "no error elements in
Circuit JSON" as success. It must independently assert, per component, that
`pad_count > 0` and that pad count matches the resolved part's pin count, failing
with `FOOTPRINT_NOT_FOUND` otherwise. Recorded here because it is easy to
"simplify" this assertion away later on the reasonable-sounding grounds that
tscircuit already validates — it does not.

---

## D-010 — Package-string → footprint mapping is Phase 3 work, and must not guess

**Phase:** 2
**Status:** Accepted

8 of 10 `package` strings taken verbatim from our fixtures (`MAPBGA-289`,
`QFN-16-EP(4x4)`, `SOP-16`, `SOIC-8`, …) are rejected by tscircuit as invalid
footprints. Only `SOT-23-6` resolves correctly. So the upstream `package` field is
**not** a tscircuit footprint and needs an explicit resolution layer.

Where no confident mapping exists, the answer is `FOOTPRINT_NOT_FOUND` — not a
visually similar substitute. A wrong-but-plausible footprint is worse than an
explicit failure because it survives review and dies at the fab.

---

## D-011 — Cache `jlcpcb:` part resolution rather than fetching per build

**Phase:** 2
**Status:** Accepted — to implement in Phase 3/5

`jlcpcb:` footprints resolve against a live JLCPCB/EasyEDA parts engine: measured
1.8–4.2 s per part, requires network, and its results can change upstream over
time — which would silently break the plan's "same input → same output" rule.

Resolved footprint/3D data will be cached keyed by part number and stored as data
in our own storage, so a design re-compiles identically and offline. This keeps the
network dependency at *resolution* time, outside the deterministic compiler path.

---

## D-012 — Pin exact tscircuit versions; no caret ranges

**Phase:** 2
**Status:** Accepted

Every tscircuit package is pre-1.0 (`@tscircuit/core` at build 1631), so semver
offers no breakage protection. Production dependencies will be pinned to exact
versions with committed lockfiles, and the Phase 2 spike doubles as the upgrade
gate — re-run it before accepting any tscircuit bump.

---

## D-013 — Licensing: MIT in the repos, undeclared on npm

**Phase:** 2
**Status:** Accepted — needs sign-off before commercial release, not a blocker now

tscircuit's GitHub repos are MIT, but ~70 packages in the installed tree (including
`@tscircuit/core` and `@tscircuit/eval`) publish **no `license` field** in their
package.json. Intent is clear; the published metadata is not. Flagged for whoever
owns third-party licensing.

Two items need a real look if their features ship: `occt-import-js` (LGPL-2.1,
STEP/CAD path) and EasyEDA/JLCPCB-sourced footprint and 3D assets, whose data terms
differ from the code license.

---

## D-014 — Circuit diagram: own symbol-based renderer, not Graphviz, not tscircuit

**Phase:** 3
**Status:** Accepted

Investigated in the order the plan required. **Option 1 (tscircuit)** — examined
every view renderer in `circuit-to-svg`, not just the schematic one: assembly,
pinout, stacked sheets, simulation. The assembly view was actually rendered to be
sure, and draws component outlines with **zero connectivity**. The schematic
renderer accepts only `grid`, `labeled`, `shouldDrawErrors` — no simplified or
symbol-only mode. `schPinArrangement`/`schPinStyles` declutter the *schematic*,
which is the artifact output #1 must be distinct from. Nothing in the ecosystem
produces a separate circuit-diagram view.

**Option 2 (chosen):** `schematic-symbols` — already in the tree, the same library
tscircuit draws from — ships 351 real EE symbols as plain vector primitives with
named ports. Built `server/src/render/` on top: real ground/VCC glyphs, a labelled
power rail, orthogonal wire-style routing, junction dots, and only the pins that
participate in a net. **Option 3 (Graphviz) was never reached** and nothing
Graphviz-based ships.

Layout is deterministic by construction (sorted by `part_class`, `ref_id`, net
name; no solver, no randomness) — verified byte-identical across repeated renders.
Full reasoning and samples: `docs/CIRCUIT_DIAGRAM_APPROACH.md`.

---

## D-015 — The circuit diagram is defined by what it omits

**Phase:** 3
**Status:** Accepted

Outputs #1 and #2 could have been the same picture twice. They are kept distinct
by a rule, not by styling: the **schematic** shows every pin with pin numbers and
net labels; the **circuit diagram** shows only pins that participate in a net,
renders grounds as ground symbols, and collapses power into one labelled rail.

Concretely: `rc_car`'s U2 is a 289-pad BGA. The schematic draws all of it; the
circuit diagram draws `VDD` and `SDA`. If a future change makes the circuit
diagram show all pins, it has stopped being output #1.

---

## D-016 — Only `SOT-23-6` resolves; matching pad count is not evidence

**Phase:** 3
**Status:** Accepted

The footprint mapper resolves exactly one of the fixtures' ten package strings.
This is deliberate, and the tempting mistake is worth naming: `soic8` really does
produce 8 pads for `SOIC-8`, `ssop24` 24 for `SSOP-24`, `bga289` 289 for
`MAPBGA-289` — all verified empirically. **Pad count agreement is not geometric
equivalence.** SOP and SOIC use different pitch conventions; `QFN-16-EP(4x4)` has
an exposed thermal pad that `qfn16` lacks; BGA ball pitch is not derivable from a
name. A wrong footprint renders perfectly and fails at the fab.

`SOT-23-6` qualifies because it is a single standardised JEDEC body with no
competing variant, so the name does determine the geometry — and that reasoning is
stored in the entry's required `evidence` field.

Near-miss candidates are returned inside the `FOOTPRINT_NOT_FOUND` payload with a
`blocker` explaining the gap, so the agent layer can explain the failure and a
human can promote one with evidence. They are never auto-selected.

---

## D-017 — `PIN_NOT_FOUND` for every fixture component, by design

**Phase:** 3
**Status:** Accepted

No verified pinout exists for any fixture part, so `pins.source` is `unresolved`
and every component raises `PIN_NOT_FOUND`. `rc_car.json` is therefore
`compilable: false` today. That is the honest answer, not a gap to paper over —
PROJECT_PLAN §4 forbids inventing a pinout.

Phase 5 makes it compilable with **explicitly labelled mocks**
(`source: "mock"`), never by weakening this. The `source` field is what keeps a
mock from silently becoming indistinguishable from verified data.

---

## D-018 — Error raised per component, not per occurrence

**Phase:** 3
**Status:** Accepted

`PIN_NOT_FOUND` is emitted once per component rather than once per net member.
`rc_car` has 9 net members across 3 components; per-member reporting would produce
9 copies of 3 facts and bury the real problem. Applies to any error whose root
cause is a component-level property.

---

## D-019 — Captured real tscircuit output as test fixtures

**Phase:** 3
**Status:** Accepted

`server/test/fixtures/circuitjson-*.json` are **real** compiled Circuit JSON
captured from tscircuit, not hand-written mocks. The zero-pad test asserts its own
premise first — that tscircuit reports zero errors and zero warnings for
`DFN-8-EP(2x3)` — before asserting our check catches it. A hand-written mock could
drift from tscircuit's real behaviour and turn the most important test in the
suite into a tautology. Regenerate from the Phase 2 spike if tscircuit is upgraded.

---

## D-020 — Real AWS S3 round-trip verified; credentials now use the default chain

**Phase:** 1 (retro-verified) / prep for Phase 5
**Status:** Accepted — supersedes part of D-002

The real AWS S3 path is now **confirmed working**, not just the MinIO stand-in:

```
bucket pcb-circuit-agent-dev-storage (eu-north-1)
PUT -> GET -> byte-compare -> DELETE   61 bytes, OK
```

Two corrections to what was originally specified:

- The bucket given as `your-project-pcb-artifacts-dev` **does not exist** (404) —
  it appears to be an unsubstituted placeholder. The real bucket matching this
  project is `pcb-circuit-agent-dev-storage`.
- It is in **eu-north-1**, not `ap-south-1`. The only ap-south-1 buckets on this
  account are `pcb-agent-tfstate-{arnav,vrusha}-2026`, which hold **Terraform
  state for the prior project** and were deliberately not touched.

**Code change:** `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` are no longer required.
When unset, the AWS SDK's default provider chain is used (shared config file, SSO,
or — importantly for production — a container/instance IAM role). Explicit keys
are still honoured, which is what MinIO needs. Passing a half-filled credentials
object hard-fails, so it is only set when both values are present.

This also reopens the section 2 note that D-002 had parked: the **6-month free
tier expiry is a live risk again** now that a real AWS dependency exists. It needs
a date attached before Phase 5 stores artifacts for real.

Dev default remains MinIO — both paths verified working after the change. To run
against real AWS:

```bash
S3_ENDPOINT="" S3_FORCE_PATH_STYLE=false \
S3_REGION=eu-north-1 S3_BUCKET=pcb-circuit-agent-dev-storage \
S3_ACCESS_KEY_ID="" S3_SECRET_ACCESS_KEY="" \
npm run storage:healthcheck
```
