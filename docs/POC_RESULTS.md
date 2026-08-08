# Phase 5 POC — results

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
