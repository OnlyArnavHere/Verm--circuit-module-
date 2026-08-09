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

---

## D-021 — The parts engine overturns Phase 3's "9 of 10 unresolvable"

**Phase:** 5
**Status:** Accepted — supersedes the practical impact of D-010

Phase 3 concluded that 9 of 10 fixture packages could not be resolved. That was
true **of the curated table**, and it is worth being precise about, because the
conclusion could easily have been carried forward as "these parts are
unresolvable" and used to justify a fully-mocked POC.

With the cached parts engine, **18 of 19 distinct parts across all four fixtures
resolve for real** by manufacturer part number. D-010's rule is unchanged and
still doing its job: a catalogue hit is accepted **only when the returned package
string matches upstream exactly**. A hit on the part number with a different
package is rejected, not warned about.

Vindication of D-010: `QFN-16-EP(4x4)` resolves to a footprint with **17 pads**
(16 + exposed thermal pad). Phase 3 refused to substitute plain `qfn16` because it
lacks the EP — the catalogue confirms that refusal was correct.

---

## D-022 — Pin names come from the catalogue, not from position

**Phase:** 5
**Status:** Accepted

Catalogue footprints expose the part's real pin names as port hints
(`LDC1314RGHR` → SCL, SDA, VDD, GND, ADDR, INTB). So logical pins are matched to
physical pads **by name** — real resolution — instead of assigned positionally.
15 of 28 logical pins across the two POC fixtures matched a real named pad.

Matching is exact-name only, plus a curated synonym table restricted to universal
equivalences (`VSS≡GND`, `VCC≡VDD`), each carrying a reason. No fuzzy matching:
"closest pin" is exactly the guess the whole design forbids.

Unmatched pins are individually tagged `source: "mock"` with a per-pin reason, and
they are why both boards are marked `manufacturable: false`. The common failure is
principled, not incidental: upstream logical names are *functions* (`SDA`, `MOSI`)
while a BGA names pins by ball coordinate (`A1`, `B3`) and an MCU by port
(`PTA0`). Bridging that needs a datasheet mux table, which we do not have.

---

## D-023 — Pin names are never borrowed across footprints

**Phase:** 5
**Status:** Accepted

`HY2111-GB` resolves via the curated table (highest trust) and therefore gets
**0/2 real pins**, because `footprinter`'s `sot23_6` exposes only positional pins.
The same part via the parts engine would expose real names.

Borrowing the names from the catalogue footprint while compiling the curated one
was rejected: pad numbering belongs to the footprint actually compiled, so names
from a different footprint could silently mis-map pads — a wrong pinout that looks
right, which is the worst failure mode in this system.

Consequence worth flagging: the most-trusted footprint path currently yields the
least pin information. Resolvable later by adding pin names to curated entries as
verified data.

---

## D-024 — `pinLabels` silently prevents PCB routing; route on pad selectors

**Phase:** 5
**Status:** Accepted — behavioural constraint on the compiler

Setting `pinLabels` on a `<chip>` causes tscircuit to emit
`pcb_trace_missing_error` for **every** connection and produce no copper.
Verified in a controlled comparison: identical boards route fine without it.

The compiler therefore does not set `pinLabels` and routes on real pad selectors
(`.U1 > .pin3`). Schematic readability is unaffected — catalogue footprints
already carry the real pin names.

This was found only because the nets-realized assertion was strengthened; the
first build reported "success" with 1 of 5 traces routed. Another instance of the
Phase 2 R1 lesson: **tscircuit's silence is not validity.**

---

## D-025 — Nets-realized assertion counts connections, not nets

**Phase:** 5
**Status:** Accepted

The original check was `traceCount > 0`, which passes a board where 1 of 5 nets
routed. It now compares actual `pcb_trace` count against expected connections
(sum of `members - 1` per net) and fails on a partial route. This is what caught
D-024. Do not weaken it back to a presence check.

---

## D-026 — `.env` pointed real AWS credentials at the local MinIO endpoint

**Phase:** 5
**Status:** Resolved

The POC's first S3 upload failed with `InvalidAccessKeyId`. Cause: `.env` had been
updated with the real bucket, `eu-north-1`, and real `AKIA…` keys, but still had
`S3_ENDPOINT=http://localhost:9100` and `S3_FORCE_PATH_STYLE=true` — so AWS
credentials were being sent to the local MinIO container.

Fixed by clearing `S3_ENDPOINT` and setting `S3_FORCE_PATH_STYLE=false`
(`.env.bak` retains the previous file). `.env` is gitignored, so the keys are not
committed. Dev can return to MinIO by restoring the endpoint — the code path is
unchanged and still supported.

---

## D-027 — A `real` claim may only be made from compiled ground truth

**Phase:** 5.6
**Status:** Accepted — binding rule

The resolver set `model_3d.source` to the *footprint's* source and attached
`pendingCompileConfirmation: true` — a flag **written once and never read**.
`compile.js` counted `cad_component`s but never fed the result back. U6
(`HY2111-GB`) therefore reported `model_3d.real = true` while having no 3D model
at all.

That is a false-real claim: precisely the failure this system exists to prevent,
produced by our own code rather than by tscircuit. The generalisable lesson is
that **an unread flag is worse than no flag** — it looks like a safeguard while
guaranteeing nothing.

The rule now: resolution records `unresolved`/`unconfirmed` for anything it cannot
itself verify, and the claim is made only by `confirmModel3d()` from actual
compiled output. A test asserts the claim tracks reality in both directions and
that the dead flag no longer exists, so this cannot regress into "always real".

Corrected result: 9/10 real 3D models, not 10/10.

---

## D-028 — Cache component data on disk; wrap `fetch`, not the parts engine

**Phase:** 5.6
**Status:** Accepted — supersedes the partial implementation of D-011

Only the LCSC code and pin names were cached. Footprint **geometry** and **3D
models** were fetched live on every compile from `registry-api.tscircuit.com` and
`modules.easyeda.com`, so "deterministic and offline" was false and every build
depended on third-party infrastructure. Community JLCPCB-data infrastructure has
been shut down before, so this is exposure, not just impurity.

Implemented as an on-disk HTTP cache (`services/httpCache.js`) following the
`jlcparts` pattern: fetch once, query locally. **Wrapping `fetch` rather than
tscircuit's parts engine is deliberate** — the 3D models are downloaded by
`circuit-json-to-gltf`, not by the parts engine, so a parts-engine-level cache
would have silently missed exactly half the problem.

Failed responses are never cached: caching a 504 would pin a transient outage
permanently. Asserted by test using the real HTTP 504 encountered during this
phase.

Verified: `--offline` (readonly cache, misses throw) produces all 4 outputs for
both fixtures with **0 network calls**.

---

## D-029 — Determinism is per-mode, and stated as such

**Phase:** 5.6
**Status:** Accepted

Measured, not assumed:

| Comparison | Result |
|---|---|
| offline ↔ offline | byte-identical |
| online ↔ online | byte-identical |
| online ↔ offline | schematic/PCB/3D differ |

tscircuit makes 8 best-effort enrichment lookups per run
(`jlcsearch.tscircuit.com/chips/list?package=…`) that fail and are therefore
correctly not cached. They fail *differently* in the two modes — failed response
vs. thrown error — which perturbs downstream output.

Rather than claim universal byte-determinism, the honest claim is: **each mode is
internally deterministic; the two modes are not identical to each other.** Caching
failures to force agreement was rejected — it would pin outages permanently
(D-028).

---

## D-030 — Curated pinouts are keyed by part number, and require correspondence evidence

**Phase:** 6
**Status:** Accepted

`HY2111-GB` resolved via the most-trusted curated footprint path yet got 0/2 real
pins, because footprinter's `sot23_6` exposes only positional pins.

Fixed by adding real data (`curatedPinouts.js`), **not** by relaxing D-023. Two
constraints make it safe:

1. **Keyed by part number, not package.** `HY2111-GB` and `LP103SB6F` are both
   `SOT-23-6` with entirely different pin functions; a package-keyed table would
   have handed one part's pinout to the other. The upstream package is kept as a
   guard, and a test asserts `LP103SB6F` inherits nothing.
2. **Correspondence must be proven, not assumed.** Pad positions were compared
   between `sot23_6` and `jlcpcb:C82747`: both number pins 1-3 along one side and
   4-6 along the other in the same order, so pin *N* is the same physical pin in
   both — they differ by a 180° rotation, which changes orientation but not pin
   identity. That reasoning lives in the entry's mandatory `evidence` field.

An entry without correspondence evidence does not belong in this table.

---

## D-031 — Producing four files is not success if assertions failed

**Phase:** 5.6
**Status:** Accepted

The POC runner reported "All required outputs produced" on a run where
`padIntegrity` had **failed** (the HTTP 504 zero-pad case), because the success
flag only tracked missing files. Four well-formed files describing a broken board
is exactly the "looks fine, is wrong" outcome the assertions exist to catch. The
exit status now requires assertions to pass as well.

---

## D-032 — Rail matching: numbered variants in, separate rails out

**Phase:** 6 (Group A)
**Status:** Accepted — corrects a previously-wrong mapping

Two changes to `matchLogicalPin`:

**Added — numbered rail variants.** Parts split rails across numbered pins
(`GND1..GND5`, `VDD1`/`VDD2`, `VSS1`/`VSS2`); those are the same net, so logical
`GND` legitimately matches `GND1`. Restricted to power/ground rails: a numbered
suffix on a *signal* pin (`DIO11`, `OUT3`, `TX1`) is a different signal, never an
alias, and a test asserts that.

**Removed — false aliases.** `VDDA`, `AGND`, `DGND`, `GNDA`, and `VIN` were
treated as generic supply/ground synonyms. They are not:

- `VDDA` is the *analog* supply, filtered separately from digital. This had
  mapped `FS32K116LFT0MLFT`'s VDD to `VDDA` (pin 6) while `VDD1` (pin 5) existed
  — an electrical error that renders perfectly.
- `VIN` on a charger/converter is the input supply, not the device's own rail.

Net effect: `FS32K116LFT0MLFT` VDD **corrected** pin6→pin5 and GND newly resolved
to `VSS1`; `RF-BM-2340A2I` GND newly resolved to `GND1`. `TP4110` VDD becomes
**unresolved** — it exposes only `VIN`, and `PIN_NOT_FOUND` is the honest answer
rather than a plausible wrong pin. 14 → 15 real pins, with one correction and one
deliberate honest regression.

---

## D-033 — A pin appearing in multiple named nets is reported

**Phase:** 6
**Status:** Accepted

`gas_leakage_detector.json` wires `U1.GPIO1` into both `GPIO_5` and `GPIO_6`. The
split-bus check deliberately skips non-bus roles because a driver fanning out to
several loads is legal, so this shape went unreported.

Added `PIN_IN_MULTIPLE_NETS` as a **distinct** check rather than widening the bus
rule, because the correct fix differs: a split bus should be merged into one bus;
a fan-out should be one net with N endpoints. The finding reports
`endpointsIfMerged` so the correction is actionable. Ground and power nets are
exempt — sharing those pins is normal and de-duplication already handles them.

It also caught a second instance not previously known: `U1.MOSI` in
`noise_pollution_monitor` (`SPI_8` and `SPI_10` both land on it).

---

## D-034 — Datasheet-extraction pilot: gates proven, live legs blocked

**Phase:** 6 (Group C pilot)
**Status:** Mechanism complete and proven; **no real extraction performed**

Built `datasheetExtraction.js` with the approved shape: datasheet-first, two
deterministic gates, human-confirm, full provenance. Both gates are proven
against deliberately-bad extractions:

| Bad claim | Caught by |
|---|---|
| `pin12` on a 6-pad SOT-23-6 | Gate 1 (structural) |
| real `pin6`, invented evidence about an I2C bus | Gate 2 (evidence) |
| `confidence: 1.0` on a claim failing both gates | neither gate consulted it |

**Two live legs could not run, and neither was faked:**

1. **No `GEMINI_API_KEY`** in this environment, so no real model call happened.
   The API key is now injectable so the gates are testable without one.
2. **The datasheet could not be fetched.** The JLCPCB part-detail page is
   reachable and yields 5 candidate PDF links, but every signed OSS URL returns
   `403 SignatureDoesNotMatch` (session-bound token), and the LCSC/EasyEDA APIs
   return 404/403 to a scripted client.

The real pilot run therefore produced exactly the designed outcome:

```
ok: false | code: PIN_NOT_FOUND | geminiCalled: false
reason: all 5 datasheet link(s) failed to download as a readable PDF
```

That is the rule working — no datasheet in hand means no model call — but it also
means **the pilot has not been validated against a real datasheet or a real model
response.** The gates are proven; the pipeline they gate is not yet exercised
end-to-end. Do not generalize to the rest of Group C on this evidence.

---

## D-035 — Group A was not the "4 easy pins" it was scoped as

**Phase:** 6
**Status:** Accepted — scoping correction

Group A was characterised (originally by me, then carried into the plan) as two
parts needing 4 pins that the catalogue already exposes. Verified against the
real pin lists, only **1 of the 4** is resolvable:

| Part | Needed | Reality |
|---|---|---|
| `RF-BM-2340A2I` | GND | ✅ `GND1` via the rail rule |
| `RF-BM-2340A2I` | TX | ❌ no TX pin; UART is firmware-mapped to a `DIOxx` |
| `MBI5124GP-B` | AUDIO | ❌ constant-current LED driver — has no audio function |
| `MBI5124GP-B` | GPIO1 | ❌ no GPIO either; its inputs are SDI/CLK/LE/OE |

The `MBI5124GP-B` pins are **upstream data errors**, not resolution gaps — the
Hardware Agent asked for functions the part does not have. `PIN_NOT_FOUND` is
correct and no datasheet will change it. Worth surfacing to whoever owns the
Hardware Agent rather than absorbing silently.

---

## D-036 — Datasheet source: LCSC, not JLCPCB

**Phase:** 6 (Group C pilot)
**Status:** Accepted — supersedes the fetch half of D-034

Both routes were tried properly before concluding.

**JLCPCB (failed).** The hypothesis that `403 SignatureDoesNotMatch` was
session-bound was tested: part-detail page loaded first with a cookie jar (4
cookies), real browser UA, then the signed OSS URL requested immediately in the
same session with the page as `Referer`. All 5 candidate links still 403'd. The
signature is bound to something a scripted client cannot reproduce.

**LCSC (works).** `www.lcsc.com/product-detail/<lcsc>.html` exposes an
**unsigned, stable** link at `datasheet.lcsc.com/datasheet/pdf/<hash>.pdf`.
Fetched 408 KB, 14,148 chars extracted.

`fetchDatasheet` now tries LCSC first and falls back to JLCPCB. Note
`www.lcsc.com/datasheet/<code>.pdf` looks like the obvious shortcut but serves an
HTML interstitial — deliberately not used.

---

## D-037 — Gemini model: `gemini-flash-latest`

**Phase:** 6
**Status:** Accepted

Measured on this key, 2026-08-09: `gemini-2.0-flash` returns **429 quota
exceeded**, `gemini-2.5-flash` returns **404 — retired for new users**,
`gemini-flash-latest` works. Using the floating alias rather than a pinned
version, since pinning is what produced both failures.

This is safe for determinism: Gemini runs only at cache-population time, never in
the compile path, and every proposal passes deterministic gates plus human
confirmation before it can affect a build.

---

## D-038 — The pilot's near-miss justifies the human gate

**Phase:** 6
**Status:** Accepted — evidence for keeping the human-confirm gate

The live run proposed `GND -> pin2` with verbatim evidence `"GND   3   2
Ground."` (table columns: name | SOP8 pin | SOT23-6 pin). Correct.

But the same datasheet's package diagram extracts as
`1 2 3 4 5 6 D+ D- PS QC_EN GND FBO`, which naively reads as **GND = pin 5**. Both
readings come from the same PDF; only one is right. The table wins because it is
explicit per-package and self-consistent (`D+`=1, `GND`=2, `FBO`=3, `QC_EN`=4,
`PS`=5, `D-`=6 — each pin used exactly once).

Two conclusions:
1. **Keep the human gate.** A plausible reading of the same source gives a wrong
   pin that both deterministic gates would pass — gate 1 (pin5 exists) and gate 2
   (the diagram text is really in the datasheet). Only a human comparing readings
   catches it.
2. **Gate 2's verbatim requirement earns its keep** — it gives the human a
   specific excerpt to check rather than a claim to trust.

The model also correctly **omitted VDD**: `LP103SB6F` has no VDD pin (its supply
is `PS`, an internally generated rail). It declined to invent one, which is the
behaviour the whole design depends on.

---

## D-039 — Confirmation is a command, not a file edit

**Phase:** 6
**Status:** Accepted

`scripts/confirm-extraction.js` makes the human gate an explicit, attributable
act (`--confirm <PIN> --by <name>`, recording who and when) rather than someone
editing a JSON cache. It **refuses to confirm a gate-rejected claim**, so the
deterministic gates are hard constraints rather than advisory.
