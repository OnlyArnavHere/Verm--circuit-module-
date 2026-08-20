# POC results — current state

**This document is the definitive summary of what the system does today.**
Sections below the horizontal rule are the chronological record of how each
result was reached; this top section supersedes them where they disagree.

---

# FINAL STATE (Phase 9)

**Verified:** 2026-08-10, from a cold state — the ~18 MB component-data cache and
all previous artifacts deleted first, so footprints and 3D models were re-fetched
over the network exactly as a handoff recipient would.

```bash
npm test                                   # 176/176 pass
node scripts/run-poc.js rc_car smart_dustbin gas_leakage_detector noise_pollution_monitor
```

## Results across all four fixtures

| | rc_car | smart_dustbin | gas_leakage | noise_pollution |
|---|---|---|---|---|
| Components | 3 | 7 | 8 | 8 |
| **Required outputs** | **4/4** | **4/4** | **4/4** | **4/4** |
| Real footprints | 3/3 | 7/7 | 8/8 | **7/8** |
| Real 3D models (post-compile) | 3/3 | 7/7 | 8/8 | **7/8** |
| Pad-integrity assertion | PASS | PASS | PASS | PASS |
| Nets-realized assertion | PASS | PASS | PASS | **FAIL** |
| DRC failures | 0 | 0 | 0 | 0 |
| DRC warnings | 9 | 21 | 24 | 21 |
| Gerbers exported | yes | yes | yes | **no** |

**Three of four fixtures pass cleanly. `noise_pollution_monitor` does not**, for
two diagnosed causes described below. The runner prints `Incomplete.` rather than
success, which is the correct report.

**Real pin resolution: 32 of 63** distinct `(part_number, pin)` pairs (51%).
Counting per-fixture instances instead — parts recur across fixtures — the same
run gives 45/79. Both numbers describe the same result; the denominators differ.

## What is genuinely proven

- **All four required outputs are real files in real formats**, produced
  headlessly and offline-capable: `circuit-diagram.svg`, `schematic.svg` +
  `.kicad_sch`, `board.kicad_pcb` + gerbers + `.drl`, and `board.glb`
  (verified by `glTF` magic bytes, not just by extension).
- **Real component data, not mocks.** 25 of 26 component instances resolved a
  real package-matched LCSC footprint and a real 3D model. The single exception
  is a part with no catalogue entry, and it is labelled `source: "mock"`.
- **All four planted upstream bugs are caught** — see
  [The four known bugs](#the-four-known-bugs--all-caught).
- **The assertions do real work.** They are what fails
  `noise_pollution_monitor`; without them it would report four outputs and look
  like a success.
- **DRC runs and blocks.** A deliberately-bad repositioning was rejected by the
  real DRC re-run with 3 failures, committing no version.
- **The versioning workflow works end to end.** Verified in this same run:
  `"move U6 2mm to the right"` → interpreted → target-checked → validated →
  recompiled → **v2 committed**, with v1 confirmed byte-identical on disk.

## The two open defects in `noise_pollution_monitor`

Both were found by this final run — the two extra fixtures had never been taken
through a full compile before, since the POC default is two fixtures.

**1. Three connections unrouted (`netsRealized` FAIL, 16 of 19 routed).**
Root cause is a single component: `U4` (`BLE-SER-A-ANT`) has no catalogue entry,
so it falls back to a mock footprint with **zero pads**. Confirmed by direct
inspection rather than inferred — `U4` appears in **zero** traces while every
other component appears, and 19 − 3 = 16 accounts for the shortfall exactly. The
three connections are `GND`, `POWER_RAIL_3V3`, and `BLE_9`. This is the
assertion behaving correctly: it refuses to call a partially-routed board a
success. It is a **catalogue gap, not a pipeline defect**.

**2. Gerber export fails (`Inner layer inner1 only supports copper gerbers`).**
`noise_pollution_monitor` is the only fixture containing a through-hole part —
`U3`, `HDSP-521G`, `DIP-18`, giving 18 `pcb_plated_hole` elements. Plated holes
span every copper layer including `inner1` on a 4-layer board, and
`circuit-json-to-gerber`'s `getGerberLayerName` throws when asked for a
non-copper gerber on an inner layer. **This is an upstream library limitation,
not our code** — reproducible in three lines against the saved `circuit.json`.
The PCB output still counts as produced because `.kicad_pcb` and `pcb.svg` are
written; only the gerber set is missing.

## Determinism — precisely bounded

Re-verified this run, and **narrower than previously claimed**:

- **Geometry is reproducible.** Two consecutive offline runs produce byte-identical
  gerbers once creation timestamps are stripped, byte-identical `.kicad_sch` once
  UUIDs are normalized, and byte-identical Circuit JSON once random element-ID
  suffixes and the `#N` instance counter are normalized. `board.glb`,
  `board.kicad_pcb`, `pcb.svg`, `schematic.svg` and `netlist.txt` are byte-identical
  with no normalization at all.
- **Raw bytes are not reproducible.** 44 of 72 files differ between two offline
  runs, entirely from embedded generation metadata: gerber `%TF.CreationDate`,
  fresh KiCad UUIDs, and tscircuit's random warning-element IDs.
- **Online and offline runs differ more** (63 of 72 files), as recorded in D-029.

D-029 previously said offline↔offline was byte-identical. That is an overclaim
and is corrected in **D-074**. The defensible claim is *geometry-level*
determinism, not byte-level.

- **Offline completeness holds:** after one warming run, all four fixtures
  compile with **0 network calls** and 65 cache hits.

## What this does NOT claim

Read this before demoing.

- **Not manufacturable.** No board here should be sent to a fab. Placement is a
  naive grid, routing is whatever tscircuit's autorouter produced, and no
  impedance, thermal, EMC, or DFM analysis exists.
- **0 DRC failures ≠ a good board.** It means no rule in
  `@tscircuit/checks` fired. Every fixture also carries 9–24 DRC **warnings**
  that were never triaged.
- **51% of pins are still positional.** Where a pin name could not be matched to
  a real named pad it is assigned positionally and labelled `mock`. Those
  assignments are **not** trustworthy and must not be manufactured — which is
  exactly why they are labelled rather than silently used.
- **Symbols are generated, not real.** Every schematic symbol is
  `source: "generated"`; none comes from a verified symbol library.
- **One fixture in four does not fully route.** Any "it works on our fixtures"
  claim must carry that qualifier.
- **The semantic target check is a heuristic over English**, not a guarantee. It
  warns, it does not block, and it returns `unverifiable` for wording outside its
  fixed vocabulary.
- **Scale is unproven.** Largest board tested is 8 components and 19 connections.
  Nothing here has met a real design of hundreds of parts.
- **Not hardened as a service.** No auth, no rate limiting, no multi-tenancy; the
  web UI is a dev upload form.
- **The parts data is a community index** (`jlcsearch.tscircuit.com` /
  `easyeda.com`), not JLCPCB's official API. It can change or disappear.

## Deferred by explicit choice

Each of these was a decision, not an oversight.

| Deferred | Why |
|---|---|
| Remaining Group C mux-table pins | The binding constraint is source-document access and model quota, not engineering. The extraction machinery is built and proven on `LP103SB6F`; running it wider needs datasheets the pipeline cannot fetch. |
| The upstream Hardware Agent selection bug | **One root cause, not six symptoms** — see [SYSTEMIC FINDING](#systemic-finding--one-upstream-bug-many-symptoms). It belongs to whoever owns the Hardware Agent; fixing it downstream would mean silently rewriting upstream intent. |
| Cosmetic schematic label collision | Visual overlap only. No effect on netlist, geometry, or any exported file. |
| Git cache history rewrite | Explicitly decided **against** — see **D-075**. |
| `BLE-SER-A-ANT` footprint | No catalogue entry exists. Inventing one would violate D-010. Correctly surfaced as a mock with zero pads. |
| Gerbers for through-hole boards | Upstream `circuit-json-to-gerber` limitation, not ours to patch here. |

---

# Chronological record

Everything below is the phase-by-phase record of how the results above were
reached, kept for audit. Where an earlier number differs from the final-state
table, the table is current.

## Phase 5 POC

**Date:** 2026-08-09
**Command:** `cd server && node scripts/run-poc.js`
**Fixtures:** `rc_car.json` (3 components) and `smart_dustbin.json` (7 components, contains the `SOT-23-6` part)
**Artifacts:** `artifacts/<fixture>/` on disk, and `s3://pcb-circuit-agent-dev-storage/jobs/poc-<fixture>/v1/` (eu-north-1) — **38 objects uploaded**

---

## Headline

**Both fixtures produced all four required outputs as real files, and resolution
was overwhelmingly real rather than mocked.**

| | rc_car | smart_dustbin |
|---|---|---|
| Required outputs | **4/4** | **4/4** |
| Real footprints | **3/3** | **7/7** |
| Real 3D models (confirmed post-compile) | **3/3** | **6/7** |
| Pins matched to real named pads | 5/8 | 12/20 |
| Pad-integrity assertion | PASS | PASS |
| DRC (Phase 5.5) | 9 findings, 0 failures | 21 findings, 0 failures |
| Nets-realized assertion | PASS (5/5 routed) | PASS (16/16 routed) |
| tscircuit compile | 1662 elements, 322 pads | 802 elements, 140 pads |

**No component fell back to a mocked footprint.** The mock fallback that remains
is confined to specific *pins* and to schematic *symbols*, detailed below.

---

## What resolved for real

### Footprints — 10/10 components, zero mocks

The Phase 3 conclusion that 9 of 10 fixture packages were unresolvable was
**about the curated table only**. Adding the cached parts engine changed the
picture completely: the JLCPCB/LCSC catalogue resolves them by manufacturer part
number, with an **exact package-string match** required before acceptance.

| Path | Count | Example |
|---|---|---|
| `parts_engine` (LCSC, package-matched, cached) | 9 | `MIMXRT1172CVM8A` → `jlcpcb:C3220126` |
| `curated` (verified table) | 1 | `HY2111-GB` (`SOT-23-6`) → `sot23_6` |

Across all four fixtures, **18 of 19 distinct parts resolve**. The single
exception is `BLE-SER-A-ANT`, which has no catalogue entry at all.

The `QFN-16-EP(4x4)` case is worth calling out: the catalogue footprint yields
**17 pads — 16 pins plus the exposed thermal pad**. Phase 3 refused to substitute
plain `qfn16` precisely because it lacks that EP. The parts engine got right what
a lookalike guess would have got wrong.

### 3D models — 9/10, confirmed against compiled output

Nine of ten components carry a real catalogue 3D model. `HY2111-GB` (U6) has
**none** — it resolves via the curated footprinter path, which has no associated
EasyEDA model.

**This originally reported 10/10, which was false.** See Phase 5.6 below: the
manifest claimed `model_3d.real = true` for U6 based on its footprint having
resolved, without ever checking whether a model existed. The claim is now made
only from actual `cad_component` elements in the compiled output.

### Pins — partially real, and this was the biggest surprise

Catalogue footprints carry the part's **real pin names** as port hints, so
logical pins can be matched to physical pads by name instead of positionally:

```
U3 LDC1314RGHR   GND -> pin8   SCL -> pin1   VDD -> pin7      (3/3 real)
U7 IS25LP080D    GND -> pin4   SCK -> pin6   VDD -> pin8      (3/3 real)
U1 TP4110        GND -> pin3   VDD -> pin16 (VDD≡V+ synonym)  (2/2 real)
```

17 of 28 logical pins across both fixtures matched a real named pad. Matching is
exact-name, plus a small curated synonym table for universal equivalences only
(`VSS≡GND`, `VCC≡VDD`) — no fuzzy matching.

---

## What fell back to mock, and why

### 1. Pins with no matching named pad — 11/28

Honest per-pin failures, not blanket mocking:

| Component | Unmatched | Why |
|---|---|---|
| `MIMXRT1172CVM8A` | GND, SDA, VDD (0/3) | 289-ball BGA; pins are named by ball coordinate (`A1`, `A10`, `B3`…), not by function. There is no pin literally called "SDA". |
| `FS32K116LFT0MLFT` | GND, SDA, MOSI, RX, AUDIO (1/6) | Real names are `VSS1`, `PTA0`, `PTB1`… Upstream's logical names are *functions*, which map to GPIO pins only via a datasheet mux table we don't have. |
| `RF-BM-2340A2I` | GND, TX (1/3) | Module pins are `DIO11`, `DIO12`… |
| `MBI5124GP-B` | AUDIO (2/3) | Part has no audio pin at all — arguably an upstream data problem, not a resolution failure. |
| `HY2111-GB` | *(resolved in Phase 6 — now 2/2 via a curated pinout)* | — |

These are assigned **positionally** and tagged `source: "mock"` with a per-pin
reason. **This is what makes the boards non-manufacturable** and it is recorded
as such in every manifest:

```json
"manufacturable": false,
"manufacturableReason": "Pin assignment is positional, not the verified pinout
   (pins.source = mock). Layout and footprints may be real, but this board must
   not be fabricated."
```

### 2. Curated footprints lose pin names — fixed in Phase 6

`U6 HY2111-GB` resolved via the **curated** table (highest trust) yet got **0/2
real pins**, because `footprinter`'s `sot23_6` exposes only positional pins.

Pin names are still **not** borrowed across footprints (D-023). The fix was to add
real data: a part-keyed curated pinout table. U6 is now **2/2 real**. See Phase 6
below.

### 3. Schematic symbols — all 10, `source: "generated"`

tscircuit draws ICs as a labelled box sized from pin count. That is the
conventional depiction and is deterministic, so it is tagged `generated` rather
than `mock` — but it is **not** the part's own symbol, so it is not `real`
either.

---

## Two real bugs found and fixed during this phase

**1. `pinLabels` silently prevents all PCB routing.** The first working build
produced 1 of 5 traces. Isolated in a controlled comparison: identical boards
route fine without `pinLabels` and emit `pcb_trace_missing_error` for *every*
connection with it. Fixed by routing on real pad selectors instead. Without the
strengthened assertion below, this would have shipped as a "successful" board
with 80% of its connections missing.

**2. The nets-realized assertion was too weak.** It only checked
`traceCount > 0`, which passes a board where 1 of 5 nets routed. It now compares
against the expected connection count, and it caught bug 1.

Both are the Phase 2 R1 lesson recurring: **tscircuit's silence is not validity.**

---

## The four known bugs — all caught

Asserted in `server/test/knownBugs.test.js` (63/63 tests pass).

| # | Bug | Detection |
|---|---|---|
| 1 | `smart_dustbin` `SPI_10`: `U7.SCK` ↔ `U1.MOSI` | `ELECTRICAL_CONFLICT` |
| 2 | `noise_pollution_monitor` `SPI_8` + `SPI_10`: same pattern twice | `ELECTRICAL_CONFLICT` ×2 |
| 3 | `noise_pollution_monitor` `I2C_7` + `I2C_11`: split half-nets at `U1.SDA` | `INVALID_NET` @ `U1.SDA` |
| 4 | Redundant `POWER_1..N` | 6 (smart_dustbin) / 7 (noise) removed, each recorded |

Corrections are **proposed, never auto-applied**: `correctedValue: null`, the
original value retained, and a reason explaining why applying it needs the real
pinout.

**A fifth issue not in the plan's table:** `I2C_7` in both `smart_dustbin` and
`gas_leakage_detector` wires `SCL` directly to `SDA` (clock to data). The plan
lists these nets only under the split-bus bug; they are *also* clock/data
conflicts. Flagged rather than silently merged into the known set.

---

## Outputs produced

Identical structure for both fixtures:

| Output | File | rc_car | smart_dustbin |
|---|---|---|---|
| 1. Circuit diagram | `circuit-diagram.svg` (+ `netlist.txt`) | 5.7 KB | 13.2 KB |
| 2. Schematic | `schematic.svg` + `schematic.kicad_sch` | 398 KB | 177 KB |
| 3. PCB | `board.kicad_pcb` + 9 Gerber layers + `.drl` + `pcb.svg` | 113 KB | 132 KB |
| 4. 3D | `board.glb` | 16.6 MB | 22.0 MB |

Plus `manifest.json`, `circuit.json`, and `generated.tsx` per fixture.

---

## Honest limitations

- **Neither board is manufacturable**, and both say so. Real footprints and real
  3D models on a board whose pin assignment is partly positional.
- **Placement is a naive grid.** Deterministic and routable, not optimised.
- **No DRC run yet.** `@tscircuit/checks` is available (Phase 2) but not wired in;
  `DRC_FAILURE` is therefore never raised.
- **`.glb` files are large** (16–22 MB) — fine for S3, likely too heavy for a
  browser viewer without decimation.
- **`BLE-SER-A-ANT` has no catalogue entry**, so `noise_pollution_monitor` cannot
  currently reach 100% real footprints. It was not used as a POC fixture.
- **Compile takes 20–37 s** per fixture, dominated by catalogue fetches on a cold
  cache. Warm-cache runs are faster; the pinout cache makes re-runs offline-capable.

## Reproducing

```bash
cd server
node scripts/run-poc.js                  # both fixtures, uploads to S3
node scripts/run-poc.js rc_car --no-upload
node --test                              # 41 tests incl. the 4 known bugs
```

Caches are committed: `parts-cache.json` (LCSC codes), `pinout-cache.json` (pin
names), and `http-cache/` (footprint geometry + 3D models, ~13 MB). A fully
offline re-run works — see Phase 5.6 for exactly what that does and does not
guarantee.

---

# Phase 5.5 — DRC wired in

`@tscircuit/checks` now runs as part of every compile
([`server/src/design/drc.js`](../server/src/design/drc.js)), so `DRC_FAILURE` is a
live path rather than a code that could never fire.

| Fixture | Findings | `DRC_FAILURE` | Warnings |
|---|---|---|---|
| rc_car | 9 | 0 | 9 |
| smart_dustbin | 21 | 0 | 21 |

Both boards produce only advisory findings (underspecified pins, no declared
power/ground pin), which are mapped to **warnings** — a board is not failed for
them.

**Proof it actually fires** (`server/test/drc.test.js`), against real compiled
output from deliberately-bad boards:

- Two chips stacked at identical coordinates → **33 failures**
  (`pcb_footprint_overlap_error`, `pcb_pad_pad_clearance_error`,
  `pcb_courtyard_overlap_error`).
- A chip placed off the board → correctly mapped to **`BOARD_CONSTRAINT_FAILURE`**,
  not `DRC_FAILURE`, since placement outside the outline is a board-constraint
  problem rather than a design-rule violation.

One implementation trap worth recording: `runAllChecks` is **async**. Calling it
without `await` yields a Promise that inspects like an empty result — reporting
"no DRC findings" for every board. A test asserts the awaited result is non-empty.

---

# Phase 5.6 — resolution-integrity fixes

Two defects from the resolution audit. Both were integrity bugs, so both are
proven by test rather than declared fixed.

## Fix 1 — false `real: true` on 3D models

**The bug.** `resolver.js` set `model_3d.source` equal to the *footprint's*
source and attached a `pendingCompileConfirmation` flag that was **written once
and never read**. `compile.js` counted `cad_component`s but never fed the result
back. U6 therefore reported `model_3d.real = true` while having no 3D model at
all — a false-real claim, the exact failure mode this system exists to prevent.

**The fix.** Resolution no longer claims a 3D model at all; it records
`source: "unresolved", unconfirmed: true`. The claim is made only by
`confirmModel3d()`, from actual `cad_component` elements in the compiled output:

| Compiled reality | Claim |
|---|---|
| `cad_component` with a model URL | `parts_engine`, `real: true`, URL recorded |
| `cad_component` with only `model_jscad` | `generated`, `real: false` — a procedural body is not the part's model |
| no model reference / no `cad_component` | `mock`, `real: false` + `MODEL_3D_NOT_FOUND` |

Corrected result: **9/10, not 10/10.** U6 now correctly reports
`model_3d: mock, real: false`.

**Proof** (`server/test/manifestAccuracy.test.js`) — asserts the claim tracks
reality in *both* directions, so it cannot regress into "always real" or "always
mock", and asserts the dead `pendingCompileConfirmation` flag no longer exists.

## Fix 2 — false determinism / offline claim

**The bug.** Only the LCSC code and pin names were cached. Footprint **geometry**
and **3D models** were fetched live on every compile from
`registry-api.tscircuit.com` and `modules.easyeda.com`. "Deterministic and needs
no network" was false, and every build depended on third-party infrastructure
staying up — infrastructure of a kind that has been taken down before.

This was not theoretical: during this phase the parts service returned **HTTP 504**
for `MBI5124GP-B`, its footprint failed to load, and the component compiled with
**zero pads**. The pad-integrity assertion caught it — a live demonstration of
both the fragility and the value of the assertion.

**The fix.** An on-disk HTTP cache
([`server/src/services/httpCache.js`](../server/src/services/httpCache.js)),
following the `jlcparts` pattern: fetch once, then query locally. It wraps `fetch`
rather than tscircuit's parts engine, deliberately — the 3D models are downloaded
by `circuit-json-to-gltf`, not the parts engine, so a parts-engine-level cache
would have missed them.

Cache: **21 entries, 12.8 MB**, committed.

**Verified:**

```
node scripts/run-poc.js --no-upload --offline
  → 25 cache hits, 0 network calls, both fixtures 4/4 outputs
```

`--offline` puts the cache in readonly mode: any request not already on disk
**throws** rather than silently reaching the network, so the run cannot
accidentally pass by fetching.

**Determinism, stated precisely:**

| Comparison | Result |
|---|---|
| offline run ↔ offline run | **byte-identical** (all 4 outputs, both fixtures) |
| online run ↔ online run | **byte-identical** |
| online ↔ offline | schematic/PCB/3D **differ**; circuit diagram identical |

The online/offline divergence is honest to report: tscircuit makes 8 best-effort
enrichment lookups per run (`jlcsearch.tscircuit.com/chips/list?package=…`) that
**fail** and are therefore correctly not cached. They fail differently in the two
modes (failed response vs. thrown error), which perturbs downstream output
slightly. Each mode is internally deterministic; they are not identical to each
other. Failed responses are never cached, so a transient outage cannot be pinned
permanently — asserted by test using the real HTTP 504 case.

---

# Phase 6 (first slice) — verified pin names for the curated path

`HY2111-GB` went from **0/2 to 2/2 real pins**:

```
U6 HY2111-GB (SOT-23-6)   VDD -> pin5 (exact)   GND -> pin6 (VSS synonym)
                          pins.source = curated,  real = true
```

**Keyed by part number, not package.** `footprintMap` is package-keyed because
package determines geometry; pinouts are the opposite. `HY2111-GB` and
`LP103SB6F` are both `SOT-23-6` with entirely different pin functions, so a
package-keyed pinout would have handed one part's pinout to the other. A test
asserts `LP103SB6F` gets no pinout rather than inheriting U6's.

**D-023 is not bypassed.** The rule forbids *borrowing* names from a footprint
other than the one compiled, because pad numbering may not correspond. Rather than
borrow, correspondence was **verified empirically**: pad positions were compared
between footprinter's `sot23_6` and the catalogue's `jlcpcb:C82747`. Both number
pins 1-3 sequentially along one side and 4-6 along the other in the same order, so
pin *N* is the same physical pin in both. The two differ by a 180° rotation —
which changes board orientation but not pin identity. That reasoning is stored in
the entry's mandatory `evidence` field.

**Remaining gap (the rest of Phase 6):** the BGA and MCU cases are unchanged —
`MIMXRT1172CVM8A` names pins by ball coordinate (`A1`) and `FS32K116LFT0MLFT` by
port (`PTA0`). Mapping `SDA`/`MOSI` onto those needs per-part datasheet mux
tables. The curated-pinout table is the mechanism for that; it just needs verified
data per part.

---

# Known open items (tracked, not yet actioned)

## SYSTEMIC FINDING — one upstream bug, many symptoms

**The Hardware Agent derives every pin name from the interface type, never from
the selected component.**

This is a single upstream defect, not a list of unrelated part-level mistakes,
and it is worth fixing at the source rather than case by case. The symptom seen
from here is that a part is chosen by `part_class`, then a net typical of that
class is attached — `AUDIO` to an `output` part, `SCL` to a `sensor`, `ANT` to a
`communication` part — without checking the specific part actually has that pin.

**Root cause, confirmed by reading the generator (D-076).** This was originally
inferred to be a defect in part *selection*. It is not — it is in *net
construction*. In `ai_engine/agents/supervisor/nodes.py`, `_interface_pin_name()`
maps an interface to pin names from a fixed table (`I2C -> (SCL, SDA)`,
`SPI -> (SCK, MOSI, MISO, CS)`, `Power -> (VDD, VCC, 3V3)`), and
`_build_nets_from_architecture()` emits one 2-member net per architecture edge —
source takes pin index 0, target index 1 — while attaching `.GND`/`.VDD` to every
reference unconditionally. The backing component dataset has **no pinout data at
all: 0 of 490,894 rows carry `pins_json`/`pinout`/`symbol`.**

**Scope is wider than this section originally claimed.** The same function also
produces all four "known bugs" of `PROJECT_PLAN.md` §1: the SCK↔MOSI pairing
(SPI edge → source `SCK`, target `MOSI`), the split I2C half-nets (I2C edge →
source `SCL`, target `SDA`, so two edges never share a rail), and the redundant
`POWER_1..N` nets (unconditional `.VDD` rail plus per-edge `Power` nets). Four
"data bugs" and five "capability mismatches" are nine symptoms of one defect.

**Therefore the fixture pin names are fabricated, and a clean pass on one of
these designs would be a false pass** — see D-076 for what that bounds, including
the 32/63 real-pin count.

Now detected automatically and continuously by `PART_CAPABILITY_MISMATCH`
(Phase 6.6), so future Hardware Agent output is checked on arrival rather than
discovered by hand. Confirmed instances in the current fixtures:

| Part | Net asks for | What the part actually is |
|---|---|---|
| `MBI5124GP-B` | `AUDIO`, `GPIO1` | constant-current LED driver — `SDI/CLK/LE/OE/OUT0-15` |
| `LMA2718T421-OA5-2` | `SCL` | analog part with a single `OUT` |
| `ESPC2-12-N4` | `ANT` | module with an **integrated** antenna |
| `TP4110` | `VDD` → `POWER_RAIL_3V3` | battery charger — only supply pin is `VIN`, the raw ~4.5–6.5 V charge input |

Two further suspected instances (`HDSP-521G` asked for `GND`/`SCK`/`VDD`;
`CD4543BM96` asked for `AUDIO`) are **deliberately not** asserted as mismatches —
our pin-name coverage for those parts is incomplete, so the check stays
conservative and reports `PIN_NOT_FOUND`. They are listed here as human
observations, not machine claims.

**Recommended upstream fix (corrected).** "Validate a net's required function
against the selected part's real pin set at selection time" is necessary but
**insufficient on its own — with no pinout data in the dataset there is nothing
to validate against.** The fix is ordered:

1. Source real per-part pinouts into the component dataset (currently 0/490,894).
2. Emit pin names from that data instead of from the interface table.
3. Then add the selection-time validation above as the guard against regression.

One fix at the root removes an entire class of defect that currently surfaces
only downstream.

## UPSTREAM DATA ERRORS — not resolution gaps

These are distinct from unresolved pins. A resolution gap means *we* lack the
data; these mean the **Hardware Agent asked for pins the part does not have**. No
datasheet, parts engine, or LLM extraction will ever resolve them, and
`PIN_NOT_FOUND` is the correct permanent answer. They belong upstream.

| Fixture | Net / pin | Problem |
|---|---|---|
| `smart_dustbin`, `gas_leakage_detector` | `U4/U7.AUDIO` (`MBI5124GP-B`) | `MBI5124GP-B` is a constant-current **LED driver**. It has no audio function at all. Its pins are `SDI`, `CLK`, `LE`, `OE`, `OUT0..OUT15`, `R-EXT`, `VDD`, `GND`. |
| `gas_leakage_detector` | `U7.GPIO1` (`MBI5124GP-B`) | Same part has no GPIO either — its control inputs are `SDI`/`CLK`/`LE`/`OE`. |
| all four fixtures | `U1/U5/U6.VDD` → `POWER_RAIL_3V3` (`TP4110`) | **Net-topology error, not a pin gap.** `TP4110` is a lithium-battery charger IC (same family as the well-known `TP4056`). Its only supply pin is `VIN`, the raw USB/wall-adapter charging input (~4.5–6.5 V) — electrically a *different net* from a 3V3 board logic rail, not another name for it. Wiring it into `POWER_RAIL_3V3` connects a charger input to a regulated logic supply. |

Worth raising with whoever owns the Hardware Agent: an `AUDIO` net onto an LED
driver suggests the upstream part-selection step matched on `part_class: output`
without checking the function actually required. The `TP4110` case is the same
shape one level up — a `power`-class part was wired to the power rail without
checking whether its supply pin is an *input to be charged from* or a *rail to be
powered by*.

`TP4110.VDD` therefore stays `PIN_NOT_FOUND` in the pipeline, and that is the
correct end state — not a gap for the extraction pipeline to keep chasing. The
pin was never ambiguous; the net is wrong.


**`gas_leakage_detector.json` — `U1.GPIO1` appears in two different nets.**
`GPIO_5` (`U1.GPIO1` ↔ `U6.GPIO1`) and `GPIO_6` (`U1.GPIO1` ↔ `U7.GPIO1`) both
terminate on the same logical pin. Same shape as the split-bus bug already caught
at `U1.SDA`, but the current `SPLIT_BUS_HALF_NETS` check only fires for
`bidir_data`/`clock` roles, so a GPIO fan-out is deliberately not flagged.

That exclusion is right in general — one GPIO driving several loads is legal —
but two *named* nets on one pin is more likely upstream modelling error than
intent. Worth a distinct check that reports the shape without asserting it is a
fault. Not urgent; recorded here so it is not lost.

---

# Phase 6 — bounded pin resolution (Groups A/B + Group C pilot)

## Pin totals, verified against the real fixture nets

**19 distinct parts · 63 logical pins referenced · 15 real · 48 unresolved.**

The plan's original per-part list was checked and found wrong in two places and
incomplete in a third: `MIMXRT1172CVM8A` needs GND/SDA/VDD (not SCL — that net
terminates on U3); `FS32K116LFT0MLFT`'s "SPI pin" is concretely `MOSI`; and the
list named 3 parts when **15** have unresolved pins.

## Group A — 1 of 4 pins, not 4

Scoped as "part already exposes matching named pads". Verified against the actual
pin lists, that holds for one pin:

| Part | Pin | Outcome |
|---|---|---|
| `RF-BM-2340A2I` | GND | ✅ `GND1` (pin1) via the new rail rule |
| `RF-BM-2340A2I` | TX | ❌ no TX pin — UART is firmware-mapped to a `DIOxx` |
| `MBI5124GP-B` | AUDIO | ❌ it is an LED driver with no audio function |
| `MBI5124GP-B` | GPIO1 | ❌ no GPIO; inputs are SDI/CLK/LE/OE |

The two `MBI5124GP-B` entries are **upstream data errors** — the Hardware Agent
requested functions the part does not physically have. No datasheet will resolve
them; `PIN_NOT_FOUND` is the correct permanent answer.

## The rail-matching rule (and a bug it fixed)

`GND` now matches `GND1`, and `VSS1` through the rail equivalence — numbered pins
of one rail are one net. Restricted to rails: `DIO11` is not `DIO`.

More importantly, **`VDDA`/`AGND`/`DGND`/`VIN` were removed as aliases.** They are
separate rails, not synonyms. This had been mapping `FS32K116LFT0MLFT`'s digital
`VDD` to `VDDA` (pin 6) while `VDD1` (pin 5) existed — an electrical error that
renders perfectly and fails in hardware.

| Change | Effect |
|---|---|
| `FS32K116LFT0MLFT` VDD | **corrected** pin6 (VDDA) → pin5 (VDD1) |
| `FS32K116LFT0MLFT` GND | newly resolved → pin7 (VSS1) |
| `RF-BM-2340A2I` GND | newly resolved → pin1 (GND1) |
| `TP4110` VDD | **now unresolved** — exposes only `VIN`; honest `PIN_NOT_FOUND` |

## Group B — blocked on the same mechanism the pilot builds

`FS32K116LFT0MLFT` and `MIMXRT1172CVM8A` were scoped as "needs a datasheet
decision". After the rail rule, what remains is exactly that:

- `FS32K116LFT0MLFT`: VDD/GND now real; **AUDIO, MOSI, RX, SDA** need a mux table
  (real pin names are `PTA0`-style ports).
- `MIMXRT1172CVM8A`: nothing resolves — a 289-ball BGA whose pins are named by
  ball coordinate (`A1`, `B3`). GND/SDA/VDD all need the datasheet.

**These cannot be completed without the datasheet path**, which is what the Group
C pilot builds — so Group B is gated on the pilot's live legs working, not on
additional design.

## Group C pilot on `LP103SB6F` — gates proven, live legs blocked

Mechanism built per the approved design ([`datasheetExtraction.js`](../server/src/design/datasheetExtraction.js)):
datasheet-first → Gemini proposes → two deterministic gates → `proposed` →
human confirms → only then eligible for `curatedPinouts.js`.

**Both gates proven against deliberately-bad extractions:**

| Deliberately-bad claim | Result |
|---|---|
| `pin12` on a 6-pad SOT-23-6 | rejected by **Gate 1** (structural) |
| real `pin6`, evidence invented ("I2C ground return for SDA/SCL") | rejected by **Gate 2** (evidence) |
| `confidence: 1.0` on a claim failing both | confidence never consulted |
| factually-true paraphrase, not an excerpt | rejected by Gate 2 — it demands source text |
| near-verbatim with whitespace/case noise | **accepted** — PDF artefacts don't cause false rejection |
| a good claim passing both gates | reaches `proposed`, **never** `verified` |

**What did NOT happen, and was not faked:**

1. **No Gemini call.** No `GEMINI_API_KEY` in this environment.
2. **No datasheet fetched.** The part-detail page is reachable and yields 5
   candidate PDF links, but every signed OSS URL returns
   `403 SignatureDoesNotMatch` (session-bound token) and the LCSC/EasyEDA APIs
   return 404/403 to a scripted client.

The real pilot run produced the designed outcome:

```
ok: false | code: PIN_NOT_FOUND | geminiCalled: false
reason: all 5 datasheet link(s) failed to download as a readable PDF
```

That is the "no datasheet ⇒ no model call" rule working correctly. But it also
means **the pipeline the gates protect has never run end-to-end.** The gates are
proven; the extraction is not. **Recommendation: do not generalize to the rest of
Group C on this evidence** — the pilot needs a working datasheet source and an
API key before its real-world performance is known.

---

# Phase 6 update — datasheet pilot ran end-to-end for real

The two blocked legs from the previous report are now **both unblocked**, and the
pilot has completed a genuine live run.

## Fetch attempt (a) — session/referer on JLCPCB: **failed, genuinely**

Hypothesis: the `403 SignatureDoesNotMatch` was session-bound. Tested properly —
loaded the part-detail page first with a cookie jar (4 cookies set), a real
browser UA, then requested the signed OSS URL immediately in the same session
with the page as `Referer`. **All 5 candidate links still returned 403
`SignatureDoesNotMatch`.** The signature is bound to something not reproducible
from a scripted client, not merely to a session.

## Fetch attempt (b) — LCSC product-detail: **works**

`https://www.lcsc.com/product-detail/C387729.html` exposes an **unsigned, stable**
datasheet URL:

```
https://datasheet.lcsc.com/datasheet/pdf/<hash>.pdf?productCode=C387729
→ 408,164 bytes, %PDF, 14,148 chars of extracted text
```

Note `www.lcsc.com/datasheet/<code>.pdf` looks like the obvious shortcut but
serves an HTML interstitial — not used. `fetchDatasheet` now tries **LCSC first**
(stable) and falls back to JLCPCB.

## The real pilot run — `LP103SB6F`

```
ok: true | geminiCalled: true
datasheet: datasheet.lcsc.com/.../acd7b00210fb12d837893c5a82865a55.pdf (408 KB)

  GND -> pin2   [proposed]
     gate1 structural: PASS  — "pin2" exists on the compiled footprint
     gate2 evidence:   PASS  (score 1.0, verbatim)
     evidence: "GND   3   2   Ground."
     model-reported confidence (NOT a gate): 0.95

  VDD: not returned by the model
```

**Both results are correct, and the second is the more interesting one.**

`LP103SB6F` genuinely has **no VDD pin** — its supply is `PS` ("Power Source.
Connection point for an external bypass capacitor for the internally generated
supply voltage"). The model omitted it rather than inventing one, and `VDD`
correctly stays `PIN_NOT_FOUND`.

### Verifying the evidence independently

The evidence `"GND   3   2   Ground."` is a row of the pin-description table,
whose columns are `name | SOP8 pin | SOT23-6 pin`. So GND is pin 3 on SOP-8 and
**pin 2 on SOT23-6**, which is our package.

This was worth double-checking, because the datasheet's package diagram extracts
as `1 2 3 4 5 6 D+ D- PS QC_EN GND FBO`, which naively reads as GND = pin 5. The
table wins: it is explicit, per-package, and **self-consistent** — `D+`=1,
`GND`=2, `FBO`=3, `QC_EN`=4, `PS`=5, `D-`=6 uses each pin exactly once. The
diagram text is column-scrambled by PDF extraction.

That near-miss is itself a finding: **a plausible reading of the same datasheet
gives the wrong pin.** It is exactly why the human-confirm gate exists, and why
gate 2 demands a verbatim excerpt that a person can check.

## Status: awaiting human confirmation

The claim is `proposed`, **not** trusted, and nothing has entered
`curatedPinouts.js`. Confirmation is an explicit, attributable command:

```bash
node scripts/confirm-extraction.js --list
node scripts/confirm-extraction.js --part LP103SB6F --package SOT-23-6 --show
node scripts/confirm-extraction.js --part LP103SB6F --package SOT-23-6 \
     --confirm GND --by "<name>"
```

A gate-rejected claim can never be confirmed — the script refuses it, so the
deterministic gates are not advisory.

---

# Phase 6.5 — catalogue/cache-completeness audit

Re-runnable: `cd server && node scripts/audit-caches.js [--probe3d]`.
Machine-readable output at `server/data/cache-audit-report.json`.

Every deterministic lookup was checked against all 19 fixture parts, including
the ones that turned out fine — the point is a reusable sweep, not a one-off.

| Dependency | Complete for the 19 parts? | Verdict |
|---|---|---|
| Parts engine (`parts-cache.json`) | 18/19 | **Not a gap** — `BLE-SER-A-ANT` is genuinely absent from LCSC |
| Footprint mapper | 19/19 determined | **GAP FOUND AND FIXED** (below) |
| Pinout cache (`pinout-cache.json`) | every resolved footprint present | **Not a gap** — extraction captures exactly what footprints expose |
| 3D model resolution | 8/10 → **10/10** | **GAP FOUND AND FIXED** (same root cause) |
| Pin-name matching | 6 well-named parts spot-checked | **Not a gap** — no missed matches |

## The one real gap: package-generic footprint shadowing part-specific

`footprintMap` is keyed by **package**; the parts engine matches by **part
number** with an exact package check. Resolution tried curated first, so the
generic `sot23_6` entry shadowed the catalogue's own footprint for the two
SOT-23-6 parts. Measured cost:

| | `sot23_6` (curated, generic) | `jlcpcb:C82747` (catalogue, part-specific) |
|---|---|---|
| pads | 6 | 6 — identical |
| pad numbering | pin1–6 | **identical** (verified against the curated pinout) |
| pin names | none | `OC, CS, OD, VSS, VDD, NC` |
| 3D model | **none** | **yes** |

So a real, resolvable 3D model was being discarded — exactly the inverse of the
false `real: true` bug: not claiming something we lacked, but discarding
something we had.

**Fix:** part-specific evidence outranks package-generic evidence (D-061). This
does **not** loosen D-010 — the exact package match is still required, and the
curated table remains the fallback for parts the catalogue lacks.

A pleasing side-effect: `jlcpcb:C387729` independently maps `GND -> pin2` for
`LP103SB6F`, corroborating the LLM-extracted, human-confirmed value from a
completely separate source.

## Result, attributed honestly

| Metric | Before | After |
|---|---|---|
| Real logical pins | 32/63 | **32/63 — unchanged** |
| 3D models (POC fixtures) | 9/10 | **10/10** |
| `smart_dustbin` 3D | 6/7 | **7/7** |

**The pin count did not move.** The two affected parts already had curated
pinouts covering their pins, so the fix changed 3D coverage, not pin resolution.
This audit was not a second D-054 — it found one real gap of moderate value, and
that is the honest result.

## What the 31 unresolved pins actually are

The audit now prints each unresolved pin against the pins the part actually has,
which turns an opaque number into two different problems with different owners:

**Part physically lacks the function — UPSTREAM data errors, unresolvable by any
datasheet work (~10 pins).** Newly identified here, beyond the known
`MBI5124GP-B` case:

| Part | Asked for | What it actually is |
|---|---|---|
| `HDSP-521G` | `GND`, `SCK`, `VDD` | a 7-segment display: pins are `A1,B1,C1,D1,E1,F1,G1,DP1…` segment anodes/cathodes |
| `CD4543BM96` | `AUDIO` | a BCD-to-7-segment decoder: `A,B,C,D,PHASE,BLANKING,F,G,E` |
| `LMA2718T421-OA5-2` | `SCL` | an analog part with a single `OUT` |
| `ESPC2-12-N4` | `ANT` | module with an integrated antenna; exposes `IO0–IO18`, `RXD0`, `TXD0` |

**Needs a datasheet mux table (~18 pins)** — MCU function names (`SDA`, `MOSI`,
`RX`) that map to port pins (`PTA0`) or BGA balls. Genuine source-document
limitation, per D-059.

**No catalogue entry (3 pins)** — `BLE-SER-A-ANT`, verified absent across four
search variants.
