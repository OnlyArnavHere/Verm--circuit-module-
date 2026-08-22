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
**Status:** Accepted — **partially superseded by D-074**

> **Correction (Phase 9):** the "offline↔offline is byte-identical" claim below
> is an overclaim. Three verification runs showed 44 of 72 files differ between
> consecutive offline runs, entirely from embedded timestamps, UUIDs, and random
> element IDs. Geometry is identical; raw bytes are not. See **D-074**. The
> cross-mode half of this decision still stands.

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

---

## D-040 — Circuit diagram restyled to per-class icons; connectivity logic reused

**Phase:** 7
**Status:** Accepted — supersedes D-014's *visual* choice, not D-015's rules

The product reference for "circuit diagram" is Fritzing/Tinkercad-style breadboard
imagery. That reference carries an assumption that does not hold here: breadboard
art presumes THT parts and modules, while this project's components are SMD/chip
level. `MIMXRT1172CVM8A` is a 289-ball BGA that cannot sit on a breadboard, and no
photorealistic image of it exists in that idiom.

Resolved by keeping the *reading experience* (approachable, non-formal, legible to
a non-engineer) and dropping the realism assumption: **eight generic per-
`part_class` icons**, connected with colour-coded wires.

Explicitly rejected, recorded so they are not drifted back into:
- physical breadboard-grid layout simulation — out of scope, meaningless for BGA/QFN
- per-exact-part image generation/lookup — no reliable per-MPN source, unbounded

**This was a rendering-layer swap, not a rebuild.** D-015's rules still govern what
is drawn: only net-participating pins, grounds as symbols, power collapsed to one
rail, orthogonal routing, deterministic layout. Only `partIcons.js` is new; the
connectivity code in `circuitDiagram.js` is unchanged.

The ground and VCC glyphs remain real EE symbols. They denote *rails*, not parts,
and no clearer pictorial exists for "this goes to ground" — the part symbols are
what changed.

---

## D-041 — Icons are original art, one per class, by IP necessity

**Phase:** 7
**Status:** Accepted

The eight icons are hand-authored flat glyphs on a 24×24 grid in
`server/src/render/partIcons.js`. They deliberately do **not** copy or imitate
Fritzing, Arduino, Tinkercad, or any vendor's board artwork — that is an IP
problem, not a style preference.

Per-class rather than per-part is also a correctness point, not just scope: there
is no meaningful pictorial for a bare BGA-289, so the icon honestly represents the
*category*. Two different sensors render identically and the part number below
disambiguates. An unknown `part_class` falls back to a neutral grey "Component"
rather than guessing an icon.

---

## D-042 — Wire colour rule: rails fixed, signals rotate by sorted index

**Phase:** 7
**Status:** Accepted

| Net | Colour |
|---|---|
| `ground` | slate `#3a3a3a` |
| `power` | red `#b3261e` |
| `signal` | 6-colour palette, indexed by position in the **name-sorted** signal list |

Rails get fixed colours because their meaning is fixed. Signals rotate so two nets
crossing the same gutter stay tellable apart. Assignment is by sorted net name and
never by draw order, so a design always yields the same colours — verified:
three renders of `smart_dustbin` are byte-identical.

Pin stubs take their net's colour, so a connection reads as one continuous run
rather than a black stub joined to a coloured wire.

---

## D-043 — First LLM-sourced pinout promoted to the curated table

**Phase:** 6
**Status:** Accepted

`LP103SB6F` `GND -> pin2` is now in `curatedPinouts.js` — the first entry sourced
through the datasheet pipeline rather than by hand. It passed every gate in order:
datasheet fetched from LCSC (408 KB), Gemini proposed with a verbatim excerpt,
gate 1 (pin2 exists on the compiled 6-pad footprint), gate 2 (evidence matched
datasheet text, score 1.0), then human confirmation
(`--confirm GND --by "vrusha"`, recorded in `datasheet-extraction-cache.json`).

Two things are deliberately preserved in the entry's `evidence`:

1. **The near-miss.** The datasheet's package diagram extracts as
   `1 2 3 4 5 6 D+ D- PS QC_EN GND FBO`, which naively reads GND = pin 5. The
   pin-description table is authoritative and self-consistent (`D+`=1, `GND`=2,
   `FBO`=3, `QC_EN`=4, `PS`=5, `D-`=6). Recorded so nobody "corrects" pin2 to
   pin5 later, and asserted by test.
2. **VDD's absence is intentional.** LP103SB6F has no VDD pin — its supply is
   `PS`, an internally generated rail — so `VDD` stays `PIN_NOT_FOUND`. The entry
   maps one pin, not two, and the resolver reports `1/2 real`.

Note the entry stores the part's **real** pin names; a logical `GND` reaches
`HY2111-GB`'s `VSS` through the rail-equivalence rule at match time, not through
the table. A test asserts the two SOT-23-6 parts keep genuinely different pinouts.

---

## D-044 — `gas_leakage_detector` net-label proximity: accepted cosmetic

**Phase:** 7
**Status:** Accepted — will not be pursued

`GPIO_5` and `I2C_3` render adjacent in `gas_leakage_detector`. Label staggering
was widened from 3 buckets to 4, which fixed `smart_dustbin`; this case remains.
Reviewed and accepted as cosmetic polish — legibility is unaffected. Logged so it
is a known state rather than an unnoticed defect.

---

## D-045 — Gate 1 normalizes pin spelling; the near-miss test found the bug

**Phase:** 6
**Status:** Accepted

The required near-miss reconstruction **failed on its first run**, and the cause
was a real defect in gate 1, not in the test.

Gate 1 compared the model's `physical_pin` to the footprint's pad names as raw
strings. Models emit the same pin as `"pin2"`, `"2"`, `"Pin 2"`, or `"PIN2"`. The
restricted extractor answered `"5"` and gate 1 rejected it as "does not exist on
the footprint" — a **false negative**. A *correct* answer written as `"2"` would
have been rejected the same way, making the gate look strict while actually being
wrong. The earlier LP103SB6F success had simply happened to come back as `"pin2"`.

Fixed with `normalizePinRef`: purely syntactic, and it never invents a pad — a
bare `N` resolves to `pinN` only if that pad exists, and BGA ball ids (`A1`) pass
through untouched. Gate 1 now reports `normalizedPin`, and the comparator compares
normalized values so `"5"` vs `"pin5"` is not mistaken for a disagreement.

The prompt now also states the footprint's pad vocabulary, which removes the
formatting mismatch at source. That tells the model how to *spell* a pin, not
which one to pick.

**This is the value of the required validation** — the mechanism looked correct
and was not. A gate that silently rejects valid answers would have shown up as an
unexplained low hit rate across the batch, and been easy to misread as "hard
parts" rather than a bug.

---

## D-046 — Near-miss reconstruction passes; cross-model independence unproven

**Phase:** 6
**Status:** Comparator proven; Extractor B blocked

After D-045, the controlled reconstruction passes:

```
A (restricted to package diagram): pin5   gates: structural PASS, evidence PASS (1.0)
B (full datasheet):                pin2   gates: structural PASS, evidence PASS (1.0)
comparator: NEEDS_REVIEW — "independent extractions DISAGREE"
```

**Both readings passed both deterministic gates and still disagreed.** That is the
whole point: the gates alone are provably insufficient on this case, because both
excerpts really are in the datasheet. Only independent re-extraction separates
them.

**Scope limit, stated plainly:** Grok returned `403 — "Your newly created team
doesn't have any credits or licenses yet."` The key authenticates; the team has no
credits. So the reconstruction ran Gemini-restricted vs Gemini-full. That proves
the **comparator**; it does **not** prove cross-model independence, which is the
property the design actually relies on.

**Auto-accept is therefore blocked**, and blocked *by construction* rather than by
policy: with Extractor B unavailable, only one extractor returns a claim, and
`comparePin` routes single-extractor results to human review. A test pins this
fail-safe so an unavailable B can never silently become auto-accept.

Until Grok has credits, the batch would resolve nothing automatically — every part
would land in human review, which is the pre-existing workflow with extra API
cost. Holding the batch rather than burning calls on a run that must be redone.

---

## D-047 — Extractor B selects its provider by key prefix, not variable name

**Phase:** 6
**Status:** Accepted

"Grok" (x.ai) and "Groq" (api.groq.com) are different vendors with near-identical
names, and this project's `.env` has held the variable `Grok_API_KEY` while the
intended value changed between them. Keying off the variable *name* would send an
x.ai key to Groq or vice versa and report a misleading `401 Invalid API Key`.

`detectProvider()` therefore dispatches on the **key prefix**, which is
unambiguous:

| Prefix | Provider | Endpoint | Default model |
|---|---|---|---|
| `gsk_…` | Groq | `api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| `xai-…` | x.ai | `api.x.ai/v1` | `grok-3` |

Both are OpenAI-compatible, so only the base URL and default model differ. An
unrecognised prefix reports that explicitly rather than guessing an endpoint.

Either provider satisfies the design requirement — Llama-on-Groq is as genuinely
distinct a model family from Gemini as Grok is. The requirement is *independence*,
not a specific vendor.

**Current state (measured, both endpoints tried with the key actually present):**

```
key prefix: xai-  -> x.ai
  x.ai : HTTP 403 — "Your newly created team doesn't have any credits or licenses yet."
  Groq : HTTP 401 — "Invalid API Key"   (as expected: it is not a Groq key)
```

So Extractor B remains unavailable and auto-accept stays blocked by construction.
The code now needs no change when a working key lands — only the `.env` value.

---

## D-048 — Gate 3: the evidence must mention the pin it claims

**Phase:** 6
**Status:** Accepted — found by the batch, not by design

The first batch auto-accepted `TP4110 VDD -> pin16` on independent agreement.
Reading the two excerpts showed the agreement was hollow:

| Extractor | Evidence | What it establishes |
|---|---|---|
| A (Gemini) | `"16   VIN   外部电源输入端"` | a pin-table row — pin 16 is VIN |
| B (Groq) | `"VDD 充电输入电压 4.5~5.5 V"` | an electrical-characteristics row. `VDD` here is a **parameter symbol**, not a pin. Establishes no pin at all. |

Both excerpts are genuinely in the datasheet, so gate 2 passed both; pin16 exists,
so gate 1 passed both; and the comparator saw matching answers. **Agreement on a
conclusion is not agreement on a fact** — and the dual-extraction design cannot
tell the difference on its own, because it compares answers, not reasoning.

Gate 3 requires the excerpt to contain the claimed pin identifier. B's evidence
mentions no pin number, so it is now rejected and the pair routes to review.

Boundary handling matters here: a bare `5` must not be satisfied by the decimals
in `4.5~5.5 V`, so token boundaries exclude `.` as well as digits. Six cases are
asserted, including `pin16` not matching `160`.

`TP4110 VDD` is therefore **not** resolved. That also preserves D-032's caution:
`VIN` on a charger is the 4.5–5.5 V charge input, and this design wires `U1.VDD`
to a 3V3 rail — so mapping `VDD -> VIN` may be electrically wrong regardless of
what the datasheet says the pin is called.

---

## D-049 — Datasheets: follow manufacturer-hosted links from LCSC

**Phase:** 6
**Status:** Accepted

The two priority parts reported "no datasheet" because the extractor only looked
for LCSC- or JLCPCB-hosted PDFs. LCSC hosts no copy for either; it links straight
to the manufacturer:

```
MIMXRT1172CVM8A -> nxp.com/docs/en/data-sheet/IMXRT1170IEC.pdf   233,905 chars
FS32K116LFT0MLFT -> nxp.com.cn/docs/en/data-sheet/S32K1xx.pdf    221,264 chars
```

External PDFs are now followed, with site boilerplate (ISO certificates, quality
policies, brochures) filtered out so it can never be mistaken for a datasheet.
Without this the two hardest and highest-value parts were silently unreachable.

---

## D-050 — Send pin-relevant sections, not whole datasheets

**Phase:** 6
**Status:** Accepted

Groq's free tier caps at **12,000 tokens/minute**; a full MCU datasheet prompt is
~27,000 tokens. Extractor B returned HTTP 413 on every part above ~40K chars, so
it never ran — and every result read as "extractor B did not return this pin",
which looks like a disagreement pattern rather than a transport failure. That is a
misleading failure mode and worth naming.

`selectPinSections` reduces the text to windows around pin-table anchors ("pin
description/configuration/function", "terminal/signal/ball map", "pinout") plus
the needed pin names, capped at 24K chars. **Both extractors receive the identical
reduced text**, so independence is unaffected, and gate 2 checks evidence against
that same text so an excerpt from a discarded section cannot pass.

This is better engineering regardless of the rate limit: a 234K-character
datasheet is mostly electrical characteristics and package drawings.

---

## D-051 — Batch incomplete: Gemini daily free-tier quota exhausted

**Phase:** 6
**Status:** Blocked — resumable

Extractor A is out of quota:

```
HTTP 429  quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier
```

Per **day**, not per minute (the accompanying `retryDelay: 37s` is misleading).
The first batch spent it across 16 parts.

Consequences, stated plainly:
- The cross-model near-miss reconstruction **did pass** with Groq as Extractor B
  before the quota ran out — the required validation is satisfied.
- The batch itself produced **0 auto-accepted pins**, and that number is not
  meaningful: Extractor B was hitting 413 for the whole run (D-050), so the
  design was never actually exercised at scale.
- Nothing was written to `curatedPinouts.js`. `auto-verified-pinouts.json` is `{}`.

The batch must be re-run once quota resets (or billing is enabled) before any
statement about hit rate is worth making.

---

## D-052 — Excerpting verified: both readings survive reduction

**Phase:** 6
**Status:** Verified

`selectPinSections` could have destroyed the property the design was validated on:
the near-miss needs LP103SB6F's datasheet to contain **both** the correct
per-package table (`"GND 3 2 Ground."` → pin2) and the misleading package diagram
(→ pin5). If reduction dropped either, disagreement becomes impossible and the
mechanism silently degrades into single-source agreement.

`scripts/verify-excerpting.js` checks the text each extractor **actually
receives**, 14/14:

| | result |
|---|---|
| A (restricted) receives the diagram, not the table | PASS |
| B receives both table and diagram | PASS |
| forced caps 8000 / 5000 / 3000 chars: reduction fires, **both survive** | PASS |
| a single reduced text still holds both the correct and misleading reading | PASS |

Worth stating precisely: at the production 24K cap this datasheet (14,148 chars)
is **not reduced at all**, so the near-miss alone does not exercise the selector.
That is why the forced-cap cases exist. The live cross-model near-miss was then
re-run with excerpting active and still passes.

---

## D-053 — "Not attempted" is not "not found"

**Phase:** 6
**Status:** Accepted — correctness fix

The batch recorded pins as `PIN_NOT_FOUND` when Extractor A had returned HTTP 429
and never ran. Those are different claims: *"we tried and it isn't there"* versus
*"we never tried"*. Conflating them overstates coverage — a run that examined 6 of
16 parts produced a report that read as complete.

Added a distinct `NOT_ATTEMPTED` outcome, plus:
- 429 retry honouring the server's own `retryDelay`, and immediate surrender on a
  **per-day** quota (waiting cannot clear it);
- the batch **aborts** on quota exhaustion instead of marking every remaining pin
  unresolvable;
- the summary lists exactly which parts were never reached.

This is the third time a transport failure has masqueraded as a result in this
phase (413s looked like disagreement, empty pad lists looked like model failure,
429s looked like PIN_NOT_FOUND). The pattern is consistent enough to name: **an
infrastructure failure that is reported as a domain answer is worse than a crash**,
because it looks like evidence.

---

## D-054 — Gate 1 needs the pad list populated first

**Phase:** 6
**Status:** Accepted — real bug found by the batch

Gate 1 checks a claimed pin against the footprint's pad list. When the pinout
cache had no entry for a footprint the list was **empty**, so gate 1 rejected
every claim as "pin does not exist on the footprint".

That reads as a model failure and is not one. `LMA2718T421-OA5-2` quoted a genuine
pin-table row — `"2   GND   Ground   Ground"` — and was rejected; likewise
`ESPC2-12-N4`. Both were reported as unresolvable when the fault was ours.

The batch now extracts a missing pinout before gating, and all 11 previously
missing footprints are populated. Re-checked deterministically against the exact
claims that failed: `LMA2718T421 GND/VDD` and `ESPC2-12-N4 GND` now pass gates 1
and 3.

Consequence worth noting: **Extractor B has still never run in a batch.** B only
runs when A produces a gate-passing claim, and gate 1 was rejecting them all. So
the dual-extraction design remains proven only by the near-miss test, not at
scale — the batch numbers so far say nothing about it.

---

## D-055 — Provider failover: degraded results never auto-accept

**Phase:** 6
**Status:** Accepted

A provider outage mid-batch no longer stops the run or produces false
`PIN_NOT_FOUND`. The remaining extractor continues and all three deterministic
gates still run — but **gate-passing in single-provider mode does not
auto-accept**. It routes to the same batched human review as a disagreement,
tagged `provider_outage` rather than `extractor_conflict`.

This is not extra caution. The LP103SB6F near-miss produced exactly this shape:
one extractor, reading only the package diagram, passed every gate and returned
the **wrong** pin. Gates verify that a claim is well-formed and genuinely quoted
from the source — internal consistency — not that it is correct. Independent
agreement is what supplies the missing evidence, so a single-provider result has
an evidentiary **gap**, not merely lower confidence.

Implementation:

| Concern | Behaviour |
|---|---|
| `verification_mode` | `DUAL` / `GEMINI_ONLY` / `GROQ_ONLY` / `NONE`, recorded on **every** result |
| One provider down | Continue on the other; gates run; gate-passing → review, never auto-accept |
| Both down | `NOT_ATTEMPTED` and halt — with no extraction there is nothing to gate |
| Transient outages | A failure marks a provider down for a 3-part cooldown, then it is retried; one 429 must not degrade the whole run |
| Warning persistence | The degraded warning is written to the batch summary **and** each affected result's provenance, not just console output — a reviewer reading the record later did not watch the run |

A test asserts the load-bearing rule directly: for both degraded modes, a claim
passing all gates yields `NEEDS_REVIEW`, never `AUTO_ACCEPTED`. Another asserts
that B being skipped *by design* (A produced nothing worth corroborating) is not
mistaken for an outage.

---

## D-056 — The batch's real win came from fixing our own bug, not from the LLM

**Phase:** 6
**Status:** Accepted — outcome record

The batch now completes: **14 parts, DUAL mode throughout, 0 NOT ATTEMPTED**.

| Outcome | Count |
|---|---|
| auto-accepted by dual extraction | **0** |
| needs review | 1 (`TP4110 VDD` — gate 3 rejecting B's parameter-symbol evidence) |
| `PIN_NOT_FOUND` (extractors ran, found nothing) | 30 |
| not attempted | 0 |

Zero auto-accepts. The honest reading is that on these parts the extractors
either declined or produced evidence that could not survive gate 3 — which is the
system working, not failing.

The substantive gain came from D-054, the empty-pad-list bug: populating the
missing pinouts let the **existing catalogue path** resolve pins that had been
wrongly reported unresolvable. Real pins went **15/63 → 32/63**, more than
doubling, with no LLM involvement at all — including `MCP7940NT-I/SN` and
`MCP9808T-E/MC` resolving completely and dropping out of the queue.

Worth stating plainly because it inverts the expected story: the expensive
mechanism contributed nothing here, and a one-line correctness fix contributed
17 pins. The dual-extraction design remains proven only by the near-miss test.

---

## D-057 — Ollama here is HOSTED cloud, not local

**Phase:** 6
**Status:** Determined empirically — changes its resilience value

Checked before wiring it in, because the answer matters:

```
localhost:11434        unreachable
`ollama` binary        not on PATH
ollama process         none
https://ollama.com/api/chat with the key   HTTP 200, real completion (gpt-oss:20b)
```

So `ollama_API_KEY` is **Ollama Cloud** — another rate-limited hosted tier, not
an unlimited local runtime. Worth stating plainly: a local Ollama would have been
a genuinely different kind of resilience (no quota, works offline, survives every
cloud outage simultaneously). A hosted tier only adds one more thing that can be
rate-limited, on a different vendor's schedule.

It exposes no rate-limit headers, so its limits are not observable in advance —
only discoverable by hitting them.

It is still worth having in Extractor B's chain: it serves `gpt-oss`, a different
model family from both Gemini and Llama, so it can stand in for B without
weakening the independence that auto-accept depends on. Verified live: with both
Groq tiers forced dead, `ollama-cloud` served the extraction and returned
well-formed JSON.

---

## D-058 — Key rotation is a credential concern, not an evidence concern

**Phase:** 6
**Status:** Accepted

Rotation sits *inside* an extractor, beneath provider-level failover:

```
Extractor A : gemini#1 -> gemini#2
Extractor B : groq#1 -> groq#2 -> ollama-cloud
```

An exhausted key moves to the next tier for the same extractor. **Whichever
credential served the request, nothing about verification changes**: the same
three gates run, the auto-accept rule is identical, and `verification_mode` stays
`DUAL`. Degraded mode applies only when an extractor exhausts *every* tier — that
is the boundary between "different credential" and "no independent second
reading". Tests assert a result served by a secondary key still auto-accepts, and
that exhausting a whole chain degrades and never auto-accepts.

Two details worth keeping:

- **Only quota-shaped failures rotate** (429/413/402/503, quota or TPM text). A
  malformed request fails identically on every credential, so rotating would burn
  keys a later part may need. Asserted by test.
- **`servedBy` is recorded** in each result's provenance, so a reviewer can tell
  which credential and model produced a claim.

---

## D-059 — Rotation is resilience, not yield; the honest limits of it

**Phase:** 6
**Status:** Accepted — expectation-setting

Recorded so this is not later mistaken for a yield improvement:

- The batch that prompted this had **zero outages and zero `NOT_ATTEMPTED`**.
  Quota was not the binding constraint on anything.
- **30 of 31 unresolved pins are source-document limitations** — mux tables that
  map functions to ports, and a BGA ball map that does not survive PDF text
  extraction. No number of keys or providers addresses a datasheet that does not
  contain the answer as text.
- Across all of Phase 6's extraction infrastructure, **one pin has been confirmed
  end-to-end** (`LP103SB6F.GND`). A single catalogue-completeness fix (D-054)
  resolved **seventeen**.

Rotation is reasonable resilience for when quota *is* the constraint. It should
not be expected to move the current numbers, and it has not been run against the
batch again for that reason.

---

## D-060 — TP4110.VDD reclassified: upstream net-topology error

**Phase:** 6
**Status:** Closed — moved out of pin resolution

`TP4110` is a lithium-battery charger IC (same family as `TP4056`). Its supply
pin `VIN` is the raw USB/wall-adapter charging input (~4.5–6.5 V) — electrically
a **different net** from a regulated 3V3 logic rail, not an alternate name for
one. So wiring `U1.VDD` into `POWER_RAIL_3V3` connects a charger input to a logic
supply.

That makes it an **upstream net-topology error**, the same category as the
SCK↔MOSI, split-I2C, and `MBI5124GP-B` phantom-pin findings — not a
pin-identification gap. It is logged in `docs/POC_RESULTS.md` under UPSTREAM DATA
ERRORS, and `TP4110.VDD` correctly remains `PIN_NOT_FOUND`.

This also settles D-032's open question in the same direction it guessed:
declining to map `VDD -> VIN` was right, and for a stronger reason than
"unverified" — the two are genuinely different nets.

---

## D-061 — Part-specific footprint outranks package-generic

**Phase:** 6.5
**Status:** Accepted — the one real gap the audit found

`footprintMap` is keyed by **package** (generic to every part with that body);
the parts engine matches by **part number** with an exact package check
(specific to this part). Resolution consulted curated first, so the generic
entry shadowed the more specific one.

Measured for the two SOT-23-6 parts: identical pad count *and* identical pad
numbering, but the catalogue footprints additionally carry real pin names and
**real 3D models**. Those were being discarded — the inverse of the false
`real: true` bug (D-027): not claiming what we lacked, but throwing away what we
had.

Order is now parts-engine first, curated as fallback. This does **not** loosen
D-010: the exact package match is still required, and curated remains the path
for parts the catalogue does not carry. The rule is simply that more specific
evidence wins when both are verified.

Verified against real data, not by inspection: `smart_dustbin` 3D models went
6/7 → 7/7, U6 switching from `sot23_6` to `jlcpcb:C82747`, with `padAssert` and
`netAssert` still passing and 4/4 outputs.

Side-benefit worth recording: `jlcpcb:C387729` independently maps `GND -> pin2`
for `LP103SB6F` — corroborating, from a completely separate source, the value
that went through LLM extraction and human confirmation.

---

## D-062 — Audit result: one moderate gap, pin count unchanged

**Phase:** 6.5
**Status:** Accepted — outcome record, stated without inflation

Expectations were set that this might find another D-054 (17 pins), several
small gaps, or nothing. What it actually found:

| Dependency | Verdict |
|---|---|
| Parts engine | complete except `BLE-SER-A-ANT`, verified genuinely absent |
| Footprint mapper | **one gap** (D-061) |
| Pinout cache | complete — extraction captures exactly what footprints expose |
| 3D models | **same gap**, 9/10 → 10/10 |
| Pin-name matching | no missed matches on six spot-checked parts |

**Real pins: 32/63, unchanged.** The fix moved 3D coverage, not pin resolution,
because the affected parts already had curated pinouts. **This was not a second
D-054**, and it would be easy to present it as one by leading with "found and
fixed a gap" — the honest framing is one moderate-value fix.

Two things worth keeping from the sweep:

1. **`BLE-SER-A-ANT`'s absence is correct behaviour.** Four search variants
   returned only unrelated fuzzy matches (74HC595 and similar); the exact-MPN
   filter rejected them. That is D-010's conservatism working, not a gap.
2. **Sparse pin naming is a catalogue limitation, not ours.** Compared raw
   `port_hints` against the cache for three parts: identical. `FS32K116LFT0MLFT`
   really does expose only 5 names of 48 pads.

---

## D-063 — Roughly a third of unresolved pins are upstream errors, not gaps

**Phase:** 6.5
**Status:** Accepted — reframes the unresolved count

The audit now prints each unresolved pin against the pins the part actually has.
That splits an opaque "31 unresolved" into two problems with different owners:

**~10 pins: the part physically lacks the function.** No datasheet work can ever
resolve these. Newly identified beyond the known `MBI5124GP-B` case:

| Part | Asked for | Reality |
|---|---|---|
| `HDSP-521G` | GND, SCK, VDD | 7-segment display — pins are segment anodes/cathodes (`A1,B1,C1,DP1`…) |
| `CD4543BM96` | AUDIO | BCD-to-7-segment decoder (`A,B,C,D,PHASE,BLANKING`) |
| `LMA2718T421-OA5-2` | SCL | analog part with a single `OUT` |
| `ESPC2-12-N4` | ANT | integrated-antenna module (`IO0–IO18`, `RXD0`, `TXD0`) |

**~18 pins: genuine mux-table gaps** — MCU function names mapping to port pins or
BGA balls, per D-059.

The pattern across `HDSP-521G`, `CD4543BM96`, `LMA2718T421` and `MBI5124GP-B` is
consistent: the Hardware Agent appears to select parts by `part_class` and then
attach a class-typical net (`AUDIO` to an `output` part, `SCL` to a `sensor`)
without checking the chosen part actually has that function. Worth raising
upstream — it is a systematic selection issue, not four coincidences.

---

## D-064 — `PART_CAPABILITY_MISMATCH`: a negative claim needs stronger evidence

**Phase:** 6.6
**Status:** Accepted

New error code, deliberately distinct from `PIN_NOT_FOUND`:

```
PIN_NOT_FOUND            "we have not resolved this — keep looking"
PART_CAPABILITY_MISMATCH "we have looked, and this part does not do it — stop"
```

Conflating them sends someone hunting a datasheet for an audio pin on an LED
driver — a search that cannot terminate. A mismatch escalates upstream instead.

The check is **general** (a part's real exposed names vs the requested function),
not a list of known cases. Proven by a synthetic test: `MCP7940NT-I/SN`, an I2C
RTC, asked for `MOSI` — a part/net combination that appears in no fixture — is
caught, using the part's real cached pin data rather than a stub.

**Three guards, because asserting absence is a stronger claim than asserting
presence.** Each exists because a real fixture part would otherwise have been
misreported:

1. **Complete pad coverage.** `HDSP-521G` names 16 of 18 pads, and the two
   unnamed ones (`pin13`/`pin14`) are exactly where a DIP-18 display's common
   pins sit. Claiming "no GND" would be a false positive, so partial coverage
   stays `PIN_NOT_FOUND`.
2. **Functional naming.** `MIMXRT1172CVM8A` names all 289 pads — by *ball
   coordinate*. This one was caught only by running the check against real data:
   it initially fired `MISMATCH` on `GND`/`VDD` for a BGA that obviously has
   both. Complete naming is not functional naming. Detected by requiring at least
   one recognised supply-rail name.
3. **Mux-assignability.** `RF-BM-2340A2I` exposes `DIO3..DIO24` and no `TX`, but
   its UART is firmware-mapped onto a DIO — a mux-table gap, not a missing
   capability. The exemption applies only to functions a GPIO could carry: an
   antenna feed cannot, so `ANT` on a comparable module *is* a mismatch.

---

## D-065 — Reclassification: 5 pins across 4 parts, not all 5 originally listed

**Phase:** 6.6
**Status:** Accepted — reports what the evidence supports

`PART_CAPABILITY_MISMATCH` now fires on:

| Part | Pin | Why it is confirmed |
|---|---|---|
| `MBI5124GP-B` | `AUDIO`, `GPIO1` | 24/24 named, functional, no generic I/O — an LED driver |
| `LMA2718T421-OA5-2` | `SCL` | 4/4 named (`OUT, GND1, GND2, VDD`) |
| `ESPC2-12-N4` | `ANT` | 16/16 named; integrated antenna, and `ANT` is not mux-assignable |
| `TP4110` | `VDD` | 16/16 named; only supply is `VIN` |

Two departures from the five originally identified by hand, both deliberate:

- **`HDSP-521G` and `CD4543BM96` were NOT reclassified.** Their name coverage is
  incomplete (16/18 and 11/16), so the check refuses to assert absence. They
  remain `PIN_NOT_FOUND` and are documented as *human observations* rather than
  machine claims. Forcing them through would have meant loosening the guard to
  reach a predetermined answer.
- **`TP4110.VDD` was added**, arriving independently at D-060's conclusion. That
  conclusion came from web research into the TP4056 family; the check reached the
  same place from the part's own confirmed pin set. Useful corroboration of both.

---

## D-066 — The systemic upstream finding, stated as one bug

**Phase:** 6.6
**Status:** For upstream handoff

The individual findings share one cause, and it is worth handing over as a single
item rather than a list of part-level complaints:

> **The Hardware Agent assigns class-typical nets without verifying the selected
> part provides that function.** A part is chosen by `part_class`, then a net
> typical of that class is attached — `AUDIO` to an `output` part, `SCL` to a
> `sensor`, `ANT` to a `communication` part — with no check that the specific
> part has that pin.

One defect, at least six symptoms across four fixtures. The recommended fix is
upstream and small: validate a net's required function against the selected
part's real pin set at selection time.

Downstream, this is now detected automatically and continuously rather than by
inspection, so future Hardware Agent output is checked on arrival.

---

## D-067 — Placement promoted to explicit ValidatedDesign state

**Phase:** 8
**Status:** Accepted — prerequisite for any modification workflow

Placement was computed inside `generateTscircuitSource` at compile time, so it
was not a value anything could read, diff, or change. A repositioning transform
would have had to reach into the compiler.

Now explicit state on `ValidatedDesign`, with the old grid as the default
generator and per-component `source: auto_grid | modified` so a later re-layout
cannot silently discard a requested position.

**Verified neutral, not assumed:** the emitted coordinates were compared against
the exact pre-Phase-8 formula for all 7 `smart_dustbin` components — identical on
every one. Worth doing, because the first attempt at this refactor was **not**
neutral: `run-poc.js` builds the compiler input from upstream + nets and did not
carry `placement`, so the compiler emitted a board with **no components at all**
(padAssert FAIL, netAssert FAIL, 3D 0/7). A "looks right" check would have missed
it; comparing artifacts caught it immediately.

Side benefit, per the plan: this closes a latent layering gap. Deciding where a
part sits is design planning — an Agent-layer concern — and it had been living
inside the deterministic compiler. Noted in `docs/ARCHITECTURE.md`.

---

## D-068 — Pre-check is a guard, not a substitute for DRC

**Phase:** 8
**Status:** Accepted — and proven, not asserted

Two layers protect a repositioning:

1. a cheap deterministic pre-check (board containment, bounding-box overlap) that
   rejects the obvious before spending a ~40s compile;
2. the **real DRC re-run**, which is authoritative.

The proof was constructed so the pre-check would *pass*. `U3` half-width 7.9 +
`U1` half-width 5.0 = 12.9mm, so placing `U3` 13.0mm away clears the bbox test by
0.1mm and sits inside the board. The real DRC still rejected it:

```
v2 BLOCKED — 33 DRC failure(s)
  DRC_FAILURE: Courtyard of U3 overlaps with courtyard of U1
  ...32 further routing failures
v1 artifacts unchanged: CONFIRMED
```

Courtyards are larger than component bodies, which a bounding-box check
structurally cannot model. That is exactly why the pre-check is not allowed to be
the gate.

---

## D-069 — Use real footprint extents, not estimated ones

**Phase:** 8
**Status:** Accepted — found by running the real request

The first end-to-end run **blocked a legitimate request**. Cause: the pre-check
was fed the count of *resolved logical pins* (2 for `U3`) instead of a real size,
so a 15.8mm module was modelled as 3mm and "left edge, 5mm margin" placed it
1.4mm off the board.

Fixed by reading true extents from `pcb_component` elements in the compiled v1
board (`componentSizesFrom`). `U3` is 15.8 × 13.2mm; the estimate said 3 × 3.

Worth recording because the failure was silent in the right direction — DRC
caught it, so nothing bad shipped, but a user would have seen a reasonable
request refused for no visible reason. A test asserts the estimate and the real
size produce *different* answers, so this cannot regress unnoticed.

---

## D-070 — Interpretation is single-extractor, unlike Phase 6

**Phase:** 8
**Status:** Accepted — deliberate asymmetry

Phase 6 requires dual independent extraction before auto-accepting a pin mapping.
Modification interpretation deliberately does **not**, and the difference is
about consequence, not confidence.

A wrong pin mapping enters `curatedPinouts.js` and silently corrupts every future
board built from it. A wrong *interpretation* cannot: it is checked by
deterministic validation, then by the real DRC re-run, and the interpreted
instruction is stored on the version for the user to read. The worst outcome is a
rejected modification with a visible reason.

Extractor B is used only as a fallback when the primary interpreter is
unavailable — the same failover shape as D-055, without the dual-agreement
requirement.

---

## D-071 — Semantic target check: the one failure geometry cannot see

**Phase:** 8
**Status:** Accepted — proven live

Every existing check validates *geometry*. None can detect that the **wrong
component** was moved: a misidentified-but-valid `ref_id` lands somewhere legal
and passes DRC, assertions, containment, everything. The board is valid and
wrong.

Demonstrated rather than argued. A request saying "move the **BLE module**" was
resolved onto `U6` (HY2111-GB, a power protection IC) and recompiled:

```
DRC: 0 failures, 21 warnings          <- geometry is perfectly clean
assertions: padIntegrity PASS  netsRealized PASS
v2 COMMITTED
```

Nothing in the pipeline objected. Only `targetCheck.js` did:

```
TARGET MISMATCH — the moved component may not be the one you meant
  The request says "ble", which describes a communication component — but the
  interpreter targeted U6, which is power (HY2111-GB). Did you mean U3?
  candidates: U3 (communication, RF-BM-2340A2I)
```

It compares the user's own words to the resolved part's real
`part_class`/`part_number` — data already in hand, no extra model call.

**Deliberately not a hard block.** It is a heuristic over English, so it will
occasionally be wrong, and being wrong-and-blocking is worse than
wrong-and-loud. The user can request a different target; same recoverability as
the rest of Phase 8.

**But loudness is the actual requirement**, so the warning prints before the move
*and* is repeated after the commit summary. A warning 200 lines up a compile log
has been buried, which is the failure mode the review specifically called out.

Five verdicts rather than a boolean, because "I cannot tell" and "this is wrong"
must not collapse together — the same distinction as `PIN_NOT_FOUND` vs
`PART_CAPABILITY_MISMATCH`:

| Verdict | Meaning |
|---|---|
| `explicit` | user named the ref_id/part number — never second-guessed |
| `consistent` | wording matches the target's class |
| `ambiguous` | wording fits the target *and* others equally |
| `unverifiable` | no recognisable description; no claim made |
| `mismatch` | wording clearly describes a different class |

Guards against crying wolf: an explicitly named `U3` is never overridden even if
other class words appear; whole-word matching stops "led" firing inside
"handled"; and two power-class parts yield `ambiguous`, not `mismatch`.

## D-072 — `noise_pollution_monitor` routing shortfall is a catalogue gap, not a pipeline defect

**Phase:** 9
**Status:** Accepted — diagnosed, deferred

The Phase 9 cold run took all four fixtures through a full compile for the first
time (the POC default is two). `noise_pollution_monitor` failed
`assertNetsRealized`: **16 of 19 connections routed**.

Diagnosed by inspection, not inference:

- `U4` (`BLE-SER-A-ANT`) has no catalogue entry, so it falls back to a mock
  footprint with **zero pads**.
- `U4` appears in **zero** `source_trace` elements. Every other component
  appears.
- `U4` participates in exactly three connections — `GND`, `POWER_RAIL_3V3`,
  `BLE_9` — and 19 − 3 = 16 accounts for the shortfall exactly.

**This is the assertion working.** A board with three unrouted connections still
produces four output files and reports zero DRC failures; without D-025's
connection counting it would have looked like a clean success.

Not fixed, because the only fixes available are worse: inventing a footprint
violates D-010, and substituting a similar module violates it more. The correct
outcome is a labelled mock plus a failed assertion, which is what happens.

## D-073 — Gerber export fails for through-hole parts on multi-layer boards (upstream)

**Phase:** 9
**Status:** Accepted — upstream limitation, documented

`circuit-json-to-gerber` throws `Inner layer inner1 only supports copper gerbers`
for `noise_pollution_monitor`. Reproducible in isolation against the saved
`circuit.json`, so it is deterministic and not a transient.

Cause: that fixture is the only one containing a through-hole part — `U3`,
`HDSP-521G`, `DIP-18` — producing 18 `pcb_plated_hole` elements. Plated holes
span every copper layer, including `inner1` on these 4-layer boards, and
`getGerberLayerName` throws rather than skipping when asked for a non-copper
gerber on an inner layer.

All four fixtures declare `layer_count: 4`, so the layer count is not the
trigger; the presence of plated holes is. The other three fixtures are entirely
surface-mount and export gerbers fine.

Not worked around. A workaround means either dropping the plated holes from the
gerber set (silently wrong output) or forcing 2-layer (silently changing the
design). Both violate "fail explicitly, never silently." The export failure is
recorded as a note on the run and the remaining PCB outputs still ship.

## D-074 — Determinism is geometry-level, not byte-level (corrects D-029)

**Phase:** 9
**Status:** Accepted — **supersedes part of D-029**

D-029 claimed offline↔offline runs are byte-identical. The Phase 9 verification
ran three full passes and **that is false**: 44 of 72 files differ between two
consecutive offline runs.

Every difference is embedded generation metadata, none is geometry:

| Artifact | What varies |
|---|---|
| `*.gbr`, `*.drl` | `%TF.CreationDate` and `G04 Created by tscircuit … date` wall-clock stamps |
| `*.kicad_sch` | freshly generated random UUIDs per element, including `(path "/…")` |
| `circuit.json` | random `…_warning_<8-12 chars>` element IDs, plus the `#N` instance counter |

Proven by normalizing each class and re-diffing — all three then compare
**identical**. `board.glb`, `board.kicad_pcb`, `pcb.svg`, `schematic.svg` and
`netlist.txt` are byte-identical with no normalization at all.

**The defensible claim is: same input + same mode → identical geometry.** Byte
comparison is only a valid regression check after normalizing timestamps, UUIDs,
and random element IDs. Anything stronger oversells it.

D-029's other half stands: online and offline runs differ more broadly (63 of 72
files), so cross-mode byte comparison remains meaningless.

## D-075 — Do not rewrite git history for the cached component data

**Phase:** 9
**Status:** Accepted — decided, not deferred

Deferred earlier until "before this repo goes public or gets other
collaborators." That condition is now true, so it is decided: **no rewrite.**

Measured rather than assumed:

- 42 `server/data/http-cache` blobs remain reachable in history, **12.2 MB
  uncompressed** — but the entire packed repository is **3.56 MiB**. A full
  clone is smaller than a single mid-sized npm dependency. The bloat concern did
  not materialize.
- The cache was untracked in `137cdbe`, so it does not grow further.
- **No secrets are involved.** `.env` was never committed, and scanning every
  commit for AWS/Gemini/Groq/x.ai key patterns returns nothing. The usual
  forcing reason for a rewrite does not apply here.
- The blobs are public component data (footprint geometry and 3D models from
  easyeda/jlcsearch), not anything private.

Against that, a rewrite changes every commit SHA, requires a force-push to the
existing GitHub remote, and breaks the audit trail — which matters unusually
much here, since this decision log and `POC_RESULTS.md` reference commits and
phases as evidence.

Trading a verifiable history for ~2 MB is a bad trade. Revisit only if a real
secret is ever committed, in which case rewriting is mandatory and the size
question is irrelevant.

## D-076 — `test-fixtures/*.json` are generator artifacts, not verified ground truth

**Phase:** post-9 (upstream integration)
**Status:** Accepted — **reframes the "known upstream bugs" of PROJECT_PLAN §1**

The four files in `test-fixtures/` have been treated throughout this project as
"four real Hardware Agent outputs" whose nets are *claims to verify*. That
framing was right, but it understated the problem: **their pin names are
fabricated by construction, and the four documented bugs are deterministic
outputs of a single upstream function** — not incidental data-entry errors in
otherwise-real designs.

### Evidence 1 — the pin vocabulary is impossibly small

Across all four fixtures the complete set of referenced pin names is eleven
strings:

```
GND, VDD, SCL, SDA, ANT, GPIO1, AUDIO, SCK, MOSI, TX, RX
```

That set covers every component, including `MIMXRT1172CVM8A` — a **289-ball
BGA**. No real pinout collapses to this vocabulary.

### Evidence 2 — the upstream generator, read directly

The upstream Hardware Agent (dunkai) builds nets in
`ai_engine/agents/supervisor/nodes.py`:

- `_interface_pin_name(interface, index)` maps an **interface type** to pin
  names from a fixed table (`I2C -> (SCL, SDA)`, `SPI -> (SCK, MOSI, MISO, CS)`,
  `Power -> (VDD, VCC, 3V3)`, …). It never consults the selected part.
- `_build_nets_from_architecture` emits one 2-member net per architecture edge,
  giving the **source** pin index 0 and the **target** pin index 1, and
  additionally attaches `.GND` and `.VDD` to *every* reference unconditionally.

Confirmed upstream: the component dataset backing this has **no `pins_json`,
`pinout`, or `symbol` data at all — 0 of 490,894 rows.** There is no per-part
pinout for the generator to have used.

### Consequence — §1's four bugs are one root cause

| PROJECT_PLAN §1 bug | Generator behaviour that produces it |
|---|---|
| `SPI_*`: `U7.SCK` tied to `U1.MOSI` | `SPI` edge → source gets index 0 (`SCK`), target index 1 (`MOSI`) |
| `I2C_7`/`I2C_11`: both end at `SDA`, never join `SCL` | `I2C` edge → source `SCL`, target `SDA`; two edges never share a rail |
| `POWER_1..N` redundant with `POWER_RAIL_3V3` | unconditional `.VDD` rail **plus** per-edge `Power` nets |
| Class-typical nets on parts lacking the function (D-06x / Phase 6.6) | interface table + unconditional rails, applied without reading the part |

These are four symptoms of one defect: **pin names are derived from interface
type, never from the selected component.**

### What this changes here

1. **Fixture pin names carry no evidentiary weight.** They may not be treated as
   ground truth in any test that asserts electrical correctness. They remain
   perfectly valid for what they have always actually exercised: intake
   structure, net de-duplication, error-path coverage, and determinism.
2. **A clean validation of a dunkai design is a false pass, not a real one.**
   Same shape as D-009 (`DFN-8-EP(2x3)`: zero errors, zero pads) and the false
   `real:true` bug — a check passing because the input is meaningless, not
   because the board is correct. If a design ever reaches `compilable: true`
   with these pin names, that is a defect report, not a milestone.
3. **The 32/63 "real pin" count is now bounded above, not asserted.** Those
   mappings resolved *fabricated logical names* against real footprints. A
   fabricated `SDA` landing on a footprint that genuinely exposes `SDA` is a
   name collision that cannot be distinguished, by this pipeline, from a correct
   mapping. `LP103SB6F.GND` (independently corroborated per Phase 6.5) is
   unaffected; the unaudited remainder is not.

The conservatism already built in is what has been protecting this repo:
`FOOTPRINT_NOT_FOUND` over lookalike substitution (D-010), `PIN_NOT_FOUND` over
invention, and `compilable: false` for `rc_car.json`. That posture is correct
and must not be relaxed to make dunkai output compile.

**Not fixed here.** The defect is upstream and out of this repo's scope. The
correct fix is at the selection step — validate a net's required function
against the selected part's real pin set — which is the same recommendation
Phase 6.6 already reached from the opposite direction.

## D-077 — Schema 2.0: upstream states interface + role, never a pin name

**Phase:** post-9 (upstream integration)
**Status:** Accepted — **supersedes the v1 net contract for new designs**

D-076 established that upstream pin names are fabricated by an interface→name
table. Schema 2.0 removes the ability to fabricate them: upstream no longer
asserts pin names at all.

### The contract

A net is **one wire**. Each member declares its **role** on that wire:

```jsonc
{ "name": "I2C_1_CLOCK", "interface": "I2C", "net_class": "signal",
  "members": [{ "ref_id": "U1", "role": "CLOCK" },
              { "ref_id": "U2", "role": "CLOCK" }] }
```

`components` is unchanged — `ref_id`/`part_class`/`part_number`/`package`/
`quantity` are catalogue facts upstream genuinely has. Only `nets` changed.

This makes three of the four §1 bugs **structurally unrepresentable** rather than
merely detected: a clock cannot be tied to a data pin (a net carries one role,
enforced by a compatibility matrix), an I2C bus cannot split into half-nets (one
net per signal, carrying every participant), and redundant `POWER_N` nets cannot
appear (rails are declared once). The checks that caught them stay — a
hand-written or third-party v2 document could still get it wrong, and trusting
that silently is exactly what this project does not do.

`TX`/`RX` is the one legitimate exception to one-role-per-net: a UART link joins
two complementary roles. It is whitelisted explicitly, not by loosening the rule.

### Both versions are accepted, and stay distinguishable

`SUPPORTED_SCHEMA_VERSIONS = ["1.0", "2.0"]`. `normalizeUpstream.js` collapses
both into one internal member shape so no downstream module needs its own
branch. Each member carries **`roleIsDeclared`**: true when upstream stated the
role (v2), false when we inferred it from an asserted pin name (v1). That flag
is load-bearing — a v1 role is evidence about a *string*, not about the part,
and the two must never blur. The five existing fixtures remain v1 and keep
D-076's framing.

### No mock path in schema 2.0

v1 falls back to labelled positional mocks so a design still compiles. **v2 does
not.** An unresolvable role stays `UNRESOLVED` and blocks compilation, reported
as `PIN_NOT_FOUND` or `PART_CAPABILITY_MISMATCH`. This is a deliberate trade:
some v2 designs will produce fewer complete artifacts than v1 did for the same
input. A design that cannot be resolved should not look manufacturable, and v1's
mock path is exactly how "looks complete" and "is correct" came apart before.

### GPIO is allocated, not looked up — and the allocation is naive

Every other role resolves by name against the part's real pins. GPIO cannot: a
GPIO net needs a *choice*. Upstream carries no sub-requirement to honour —
verified, the architecture edge schema is `{source, target, interface}` with no
qualifier field, and `PWM`/`ADC`/`Analog`/`I2S` are first-class interfaces rather
than GPIO sub-roles, so nothing is being discarded. `allocateGpio()` therefore
takes the **lowest-numbered unallocated general-purpose pad**, deterministically,
and records a `GPIO_ALLOCATED` modification with its reason. It is never silent.

**Accepted limitation — numeric order is not electrical suitability.** Real parts
have pins that are unsuitable for an arbitrary GPIO assignment:

- **strapping/boot pins** sampled at reset (a pull-up can change boot mode),
- **input-only** pins that cannot drive an output,
- **programming/debug pins** (SWD/JTAG/UART bootloader) that break flashing,
- pins with **special analog or high-current** characteristics.

`extractPinout()` returns only names and pad numbers — **there is no per-pin
capability metadata to filter on**, so no amount of care in the allocator can
currently avoid these. Numeric-order allocation is an MVP limitation, accepted
knowingly, **not a bug**. It is safe to ship because the allocation is recorded
as a modification a human can review, not buried.

Revisit if per-pin capability data becomes available — catalogue attributes, a
curated per-part table in the shape of `curatedPinouts.js`, or datasheet
extraction. At that point the allocator should filter candidates by suitability
before ordering them. Until then, do not present GPIO assignment as verified: it
is a deterministic guess with a paper trail.

## D-078 — Gate any future fab-facing route on `compilable` and mocked pins

**Phase:** post-9
**Status:** Accepted — **deferred by design, not overlooked**

A guard preventing fabrication-facing actions from firing on an unverified design
was scoped, then deliberately **not built**, because there is nothing to attach
it to: `routes/jobs.js` exposes upload, list, get, upstream, and a presigned
output URL. No gerber-export route and no order-PCB route exist. Writing the
guard now would mean writing a guard around an imaginary call site.

This entry exists so the requirement is not lost when that route is added.

**When a gerber-export, order-PCB, or any other fabrication-facing route is
added, it MUST refuse to proceed unless `compilable === true` and
`mockedPinCount === 0`.** Not warn — refuse. Returning files for a design whose
pins were positionally mocked is precisely the "looks complete, is not correct"
failure this project exists to prevent (D-009, D-027).

Two traps to avoid when that day comes:

- **`hasAllOutputs` is not a correctness signal.** It counts whether four files
  exist, nothing more, and it sits next to `outputs` in `toPublicJSON()` where it
  reads like a green light. A design can have all four artifacts and still be
  `compilable: false`.
- **`artifact.mocked` is not sufficient either.** It is per-artifact and boolean,
  while mocked-pin state is per-pin and lives in `resolution.pins.perPin`. A
  board can carry a MOCK-sourced pin while every artifact reports
  `mocked: false`.

Note the prerequisite: as of this entry neither `compilable` nor
`mockedPinCount` reaches the API at all, because the HTTP job flow never invokes
the design layer (no job advances past `received`). Surfacing them is a
precondition for this guard, not a separate nicety.
