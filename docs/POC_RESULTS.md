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
| Real 3D models | **3/3** | **7/7** |
| Pins matched to real named pads | 5/8 | 10/20 |
| Pad-integrity assertion | PASS | PASS |
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

### 3D models — 10/10

Every resolved part carried a catalogue 3D model (`cad_component`), so both
`.glb` files contain real component bodies rather than placeholder blocks.

### Pins — partially real, and this was the biggest surprise

Catalogue footprints carry the part's **real pin names** as port hints, so
logical pins can be matched to physical pads by name instead of positionally:

```
U3 LDC1314RGHR   GND -> pin8   SCL -> pin1   VDD -> pin7      (3/3 real)
U7 IS25LP080D    GND -> pin4   SCK -> pin6   VDD -> pin8      (3/3 real)
U1 TP4110        GND -> pin3   VDD -> pin16 (VDD≡V+ synonym)  (2/2 real)
```

15 of 28 logical pins across both fixtures matched a real named pad. Matching is
exact-name, plus a small curated synonym table for universal equivalences only
(`VSS≡GND`, `VCC≡VDD`) — no fuzzy matching.

---

## What fell back to mock, and why

### 1. Pins with no matching named pad — 13/28

Honest per-pin failures, not blanket mocking:

| Component | Unmatched | Why |
|---|---|---|
| `MIMXRT1172CVM8A` | GND, SDA, VDD (0/3) | 289-ball BGA; pins are named by ball coordinate (`A1`, `A10`, `B3`…), not by function. There is no pin literally called "SDA". |
| `FS32K116LFT0MLFT` | GND, SDA, MOSI, RX, AUDIO (1/6) | Real names are `VSS1`, `PTA0`, `PTB1`… Upstream's logical names are *functions*, which map to GPIO pins only via a datasheet mux table we don't have. |
| `RF-BM-2340A2I` | GND, TX (1/3) | Module pins are `DIO11`, `DIO12`… |
| `MBI5124GP-B` | AUDIO (2/3) | Part has no audio pin at all — arguably an upstream data problem, not a resolution failure. |
| `HY2111-GB` | GND, VDD (0/2) | See the tradeoff below. |

These are assigned **positionally** and tagged `source: "mock"` with a per-pin
reason. **This is what makes the boards non-manufacturable** and it is recorded
as such in every manifest:

```json
"manufacturable": false,
"manufacturableReason": "Pin assignment is positional, not the verified pinout
   (pins.source = mock). Layout and footprints may be real, but this board must
   not be fabricated."
```

### 2. A real tradeoff: curated footprints lose pin names

`U6 HY2111-GB` resolves via the **curated** table (highest trust — verified
geometry) yet gets **0/2 real pins**, because `footprinter`'s `sot23_6` exposes
only positional pins. The same part via the parts engine (`jlcpcb:C82747`) would
expose real names (`VDD`, `VSS`, `OD`, `OC`, `CS`).

Pin names are **deliberately not** borrowed across footprints: pad numbering
belongs to the footprint actually compiled, so taking names from a different one
could silently mis-map pads. Correct behaviour, but it means the most-trusted
footprint path currently yields the least pin information. Flagged for review.

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

Asserted in `server/test/knownBugs.test.js` (41/41 tests pass).

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

Caches (`server/data/parts-cache.json`, `pinout-cache.json`) are committed, so a
re-run is deterministic and needs no network.
