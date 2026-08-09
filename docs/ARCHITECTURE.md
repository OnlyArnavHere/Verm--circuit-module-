# Architecture — agent layer vs. deterministic layer

**Date:** 2026-08-09 · **Phase:** 4

```
┌──────────────┐   ┌──────────────────┐   ┌─────────────────────┐   ┌───────────┐
│  LLM Agent   │──▶│  ValidatedDesign │──▶│ Deterministic       │──▶│ tscircuit │──▶ Artifacts
│  layer       │   │  (schema)        │   │ Compiler            │   │           │
└──────────────┘   └──────────────────┘   └─────────────────────┘   └───────────┘
   interprets          the contract           resolves, validates,      renders,
   and plans                                  compiles, asserts         exports
```

The rule that overrides everything else: **the LLM never emits geometry that is
trusted blindly.** It interprets, plans, and explains. Everything that lands in an
artifact passes through the deterministic layer first.

The practical test: if you are about to have the agent generate tscircuit code and
run it, stop — route it through `ValidatedDesign` instead.

---

## Layer ownership

### The LLM agent layer owns

| Responsibility | What it looks like |
|---|---|
| **Interpretation** | Reading upstream intent; deciding what a design is *for* when the JSON is ambiguous |
| **Component-resolution decisions** | Choosing between two plausible candidate parts; deciding an LCSC match is acceptable |
| **Ambiguity handling** | "`U3.ANT` could be an antenna feed or a test point" — surfacing the choice |
| **Explaining errors** | Turning `FOOTPRINT_NOT_FOUND @ U2` into something a human can act on |
| **Modification requests** | "Move the regulator away from the antenna" → a new `ValidatedDesign` → a new version |
| **Proposing corrections** | Suggesting `SPI_10` should be `U7.SCK ↔ U1.SCK`, with reasoning |

### The deterministic layer owns

| Responsibility | Module |
|---|---|
| Intake structural validation | `upstream/intakeCheck.js` |
| Schema construction + net de-duplication | `design/validatedDesign.js` |
| Footprint resolution (curated) | `design/footprintMap.js` |
| Parts-engine resolution + caching | `design/partsEngine.js` |
| Per-field real/mock resolution | `design/resolver.js` |
| Electrical / protocol validation | `design/electricalChecks.js` |
| Part-capability validation | `design/capabilityCheck.js` |
| tscircuit error ingestion | `design/tscircuitErrors.js` |
| Independent post-compile assertions | `design/assertions.js` |
| Compilation + artifact generation | `compile/` |
| Circuit-diagram rendering | `render/circuitDiagram.js` |

**Nothing in the right-hand column calls an LLM.** That is what makes
"same `ValidatedDesign` + same compiler version + same library → same output"
true, and it is why the compiler can be tested without a model in the loop.

### The boundary, stated as a rule

The agent may **propose**; only the deterministic layer may **accept**.

An agent suggestion becomes real by being written into a `ValidatedDesign` field
with a `source` — and every non-verified source is visible downstream. An agent
cannot make a mock look verified, because it does not get to write `source`.

---

## Resolution model — per field, not per component

A component is rarely all-real or all-mock. Resolution is tracked **per field**,
because "real footprint, unknown pinout" is a genuinely different state from
"nothing resolved" and collapsing them hides real progress:

```jsonc
{
  "ref_id": "U5",
  "footprint": { "value": "jlcpcb:C382136", "source": "parts_engine", "padCount": 16 },
  "pads":      { "source": "parts_engine", "count": 16 },
  "model_3d":  { "value": "...", "source": "parts_engine" },
  "symbol":    { "source": "mock", "reason": "no schematic symbol for this MPN" },
  "pins":      { "source": "mock", "reason": "no verified pinout; logical->pad is positional" }
}
```

### Resolution order (real first, mock last)

For each field, in order — first hit wins, and the winner's provenance is recorded:

1. **Curated table** (`footprintMap`) — human-verified, carries `evidence`. Highest trust.
2. **Parts engine** (`jlcpcb:`/LCSC via jlcsearch), cached — accepted **only when
   the returned package string matches upstream's exactly**. A package mismatch is
   a rejection, not a warning: it is the same lookalike-substitution failure the
   curated table exists to prevent.
3. **Mock** — explicit, per-field, with a `reason`. Never silent, never a default.

`source: "mock"` propagates into the job record, the manifest, and the artifact
metadata. A fully-mocked design is a legitimate *state*; it is not a success.

---

## Error taxonomy

Every failure is one of these codes. The system never guesses and never claims
validity it hasn't established.

| Code | Triggered when | Raised by | Recoverable by agent? |
|---|---|---|---|
| `COMPONENT_NOT_FOUND` | A net references a `ref_id` not in `components`; or no catalogue entry for a part number | `validatedDesign`, `resolver` | Yes — propose a substitute for human approval |
| `PIN_NOT_FOUND` | A logical pin (`U1.SDA`) has no verified mapping to a physical pad, and the part's capability set is **not** confirmed complete — it may still exist | `validatedDesign`, `resolver` | Yes — propose a pinout from a datasheet |
| `PART_CAPABILITY_MISMATCH` | The part's real pin set is **confirmed complete and functionally named**, and the requested function is not in it. The part does not do this | `capabilityCheck`, via `resolver` | **No** — this is an upstream net-assignment error; no datasheet work can close it |
| `FOOTPRINT_NOT_FOUND` | No verified footprint; **or** a resolved footprint produced zero pads; **or** pad count ≠ expected | `footprintMap`, `assertions` | Yes — propose a candidate with evidence |
| `MODEL_3D_NOT_FOUND` | No 3D model available for a resolved part | `resolver` | Non-blocking — 3D output is marked degraded |
| `INVALID_NET` | A net is malformed, empty, or has a single endpoint | `validatedDesign` | Yes |
| `ELECTRICAL_CONFLICT` | Two incompatible pin roles on one net (clock↔data), or split half-nets that should be one bus | `electricalChecks` | Yes — propose a correction, logged as a modification |
| `UNSUPPORTED_COMPONENT` | Part class/property tscircuit cannot express | `tscircuitErrors` | Sometimes |
| `ROUTING_FAILURE` | Autorouter failed, or declared signal nets produced zero traces | `tscircuitErrors`, `assertions` | Retry with different constraints |
| `DRC_FAILURE` | `@tscircuit/checks` reports a violation | `tscircuitErrors` | Yes — adjust placement/clearance |
| `BOARD_CONSTRAINT_FAILURE` | Outline missing/invalid; component outside board | `validatedDesign`, `tscircuitErrors` | Yes |

Plus two intake-level codes outside the design taxonomy (D-006):
`MALFORMED_UPLOAD`, `UNSUPPORTED_SCHEMA_VERSION`.

### `PIN_NOT_FOUND` vs `PART_CAPABILITY_MISMATCH`

These look similar and mean opposite things, so the split is worth stating
plainly:

```
PIN_NOT_FOUND            "we have not resolved this — keep looking"
PART_CAPABILITY_MISMATCH "we have looked, and this part does not do it — stop"
```

Sending someone to hunt a datasheet for an audio pin on an LED driver wastes
their time and never terminates. A mismatch escalates upstream instead.

A mismatch is only claimed when **all three** hold, because a negative claim
needs stronger evidence than a positive one:

1. **Complete pad coverage** — every pad has a name. `HDSP-521G` names 16 of 18,
   and the two unnamed pads are where a DIP-18 display's commons sit, so it stays
   `PIN_NOT_FOUND`.
2. **Functional naming** — at least one supply rail is named. `MIMXRT1172CVM8A`
   names all 289 pads by *ball coordinate*; complete naming is not functional
   naming, and it says nothing about capability.
3. **Not mux-assignable onto existing generic I/O** — `RF-BM-2340A2I` has no `TX`
   pin but exposes `DIO3..DIO24`, and its UART is firmware-mapped, so `TX` is a
   mux-table gap rather than a missing capability. An antenna feed is not
   mux-assignable, so `ANT` on the same class of part *is* a mismatch.

### Response shape

Uniform across every layer:

```jsonc
{
  "code": "FOOTPRINT_NOT_FOUND",
  "severity": "error",            // "error" | "warning"
  "message": "Human-readable, names the thing and why it failed.",
  "target": "U2",                 // ref_id, "U1.SDA", or "nets.SPI_10"
  "detail": {                     // machine-readable; shape varies by code
    "package": "MAPBGA-289",
    "candidates": [{ "footprint": "bga289", "padCount": 289, "blocker": "ball pitch not derivable" }]
  }
}
```

`detail.candidates` is what lets the agent layer explain a near miss without the
deterministic layer ever selecting one.

### Corrections are recorded, never silent

Any time the validator changes upstream data, a `modification` is written with the
original value, the correction, and the reason (PROJECT_PLAN §5):

```jsonc
{
  "target": "nets.POWER_1",
  "originalValue": ["U1.VDD", "U2.VDD"],
  "correctedValue": null,
  "reason": "Fully contained in POWER_RAIL_3V3, which already connects all endpoints.",
  "detectedBy": "NET_SUBSUMED_BY_LARGER_NET"
}
```

---

## Two invariants that must not be optimised away

**1. Absence of errors is not proof of validity.**
`DFN-8-EP(2x3)` compiles with zero errors, zero warnings, and zero pads (Phase 2
R1). `assertions.js` therefore runs independently of what tscircuit reported. Any
future refactor that makes assertions conditional on tscircuit's error list
reintroduces the exact bug they exist to catch.

**2. Provenance survives to the output.**
`source` is not debug metadata. It reaches the manifest and the job record so a
consumer can tell a verified board from a plausible-looking mock. A "cleanup" that
drops `source` on the way to the artifact silently destroys that distinction.

---

## Job lifecycle

```
received → validating → resolving → compiling → generating → uploading → completed
                                                                        ↘ failed
```

Each transition emits a Socket.IO event to `job:<id>` and the `jobs` firehose, and
persists to MongoDB — so other platform agents can follow live or read after the
fact. Socket delivery is best-effort; **MongoDB is the durable record.**

Change requests create a **new version** (`parentJobId`), never an overwrite.
