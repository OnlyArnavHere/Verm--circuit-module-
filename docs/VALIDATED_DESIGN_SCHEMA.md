# ValidatedDesign — schema and rationale

**Date:** 2026-08-09 · **Phase:** 3 · **Version:** `1.0`
**Implementation:** [`server/src/design/validatedDesign.js`](../server/src/design/validatedDesign.js)

The deterministic contract between the agent layer and the compiler:

```
LLM Agent  →  ValidatedDesign  →  Deterministic Compiler  →  tscircuit  →  Artifacts
```

Everything downstream of this object is deterministic. If a value is in here, it
is either copied verbatim from upstream or resolved from a verified source — and
the object records which. Nothing is inferred.

---

## Design principles

**1. Every resolved value carries its `source`.**
This is the schema's most important property. A footprint that came from our
verified table and a footprint someone mocked in to make a demo work must not be
indistinguishable at compile time:

```js
RESOLUTION_SOURCE = { UPSTREAM, CURATED, PARTS_ENGINE, MOCK, UNRESOLVED }
```

`UNRESOLVED` must never reach the compiler. `MOCK` may, but only when explicitly
labelled — which is what lets Phase 5 honour "label every mock".

**2. Unresolved is represented, not omitted.**
An unknown footprint is `{value: null, source: "unresolved"}` **plus** a
`FOOTPRINT_NOT_FOUND` error — never a missing key, and never a plausible default.
A missing field could be mistaken for "not applicable"; an explicit `unresolved`
cannot.

**3. tscircuit-agnostic.**
`footprint` is a string, `pad` is a number/name, coordinates are millimetres.
Nothing here imports tscircuit or mentions Circuit JSON. Swapping the renderer
should not reshape this schema.

**4. Upstream data is never mutated in place.**
Corrections produce entries in `modifications` with the original value, the
correction, and the reason (PROJECT_PLAN §5).

---

## Schema

```jsonc
{
  "validated_design_version": "1.0",
  "design_name": "dunkai_design",
  "upstream_schema_version": "1.0",

  "components": [{
    "ref_id": "U1",
    "part_number": "TP4110",
    "part_class": "power",
    "package": "SOP-16",                    // verbatim from upstream

    "footprint": {
      "value": null,                        // tscircuit footprint string
      "expectedPadCount": null,             // asserted after compile
      "source": "unresolved",
      "evidence": null                      // why we trust it — required when resolved
    },

    "pins":    { "source": "unresolved", "map": {} },  // logical -> physical
    "symbol":  { "value": null, "source": "unresolved" },
    "model3d": { "value": null, "source": "unresolved" }
  }],

  "nets": [{
    "name": "POWER_RAIL_3V3",
    "net_class": "power",
    "members": [{
      "ref_id": "U1",
      "logicalPin": "VDD",                  // upstream's logical name
      "physicalPin": null,                  // resolved pin identifier
      "pad": null,                          // physical pad number
      "source": "unresolved"
    }]
  }],

  "constraints": {
    "layer_count": 4,
    "board_outline": { "shape": "rectangle", "width_mm": 100, "height_mm": 60 }
  }
}
```

`buildValidatedDesign(upstream)` returns
`{ design, errors, modifications, compilable }`. **`compilable` is computed from
the error list, never assumed from an absence of complaints** — the same
principle that the pad assertion enforces downstream.

### Field notes

| Field | Why it exists |
|---|---|
| `footprint.expectedPadCount` | The input to the independent pad assertion. Without a number to check against, a wrong-but-nonempty footprint passes. |
| `footprint.evidence` | Forces a human reason into the record. An entry cannot be promoted to `curated` by assertion alone. |
| `pins.map` | Logical (`U1.SDA`) → physical pad. Empty and `unresolved` until a verified pinout exists. |
| `members[].logicalPin` | Preserved even when unresolved, so an error can name what failed. |
| `symbol` / `model3d` | Present from the start so `MODEL_3D_NOT_FOUND` has somewhere to live. |

---

## Hand validation against `rc_car.json`

Actual output of `buildValidatedDesign(rc_car.json)` — the plan's Phase 3
requirement. Result: **3 components, 3 nets, 6 errors, 2 modifications,
`compilable: false`.**

### Components — all three unresolved, none guessed

| ref | part_number | package | footprint | source |
|---|---|---|---|---|
| U1 | TP4110 | `SOP-16` | `null` | `unresolved` |
| U2 | MIMXRT1172CVM8A | `MAPBGA-289` | `null` | `unresolved` |
| U3 | LDC1314RGHR | `QFN-16-EP(4x4)` | `null` | `unresolved` |

Correct per Phase 2: none of these three packages resolves to a verified
footprint. `MAPBGA-289` has a `bga289` candidate with a matching 289-pad count,
and it was **not** substituted — ball pitch is not derivable from the name.

### Nets — 5 upstream became 3

| Upstream net | Outcome |
|---|---|
| `GND` (3 members) | kept |
| `POWER_RAIL_3V3` (3 members) | kept |
| `POWER_1` = {U1.VDD, U2.VDD} | **removed** — subsumed by `POWER_RAIL_3V3` |
| `POWER_2` = {U1.VDD, U3.VDD} | **removed** — subsumed by `POWER_RAIL_3V3` |
| `I2C_3` (2 members) | kept |

This is the fourth known bug from PROJECT_PLAN §1, caught here. Both removals are
recorded, never silent:

```json
{
  "target": "nets.POWER_1",
  "originalValue": ["U1.VDD", "U2.VDD"],
  "correctedValue": null,
  "reason": "Net \"POWER_1\" is fully contained in \"POWER_RAIL_3V3\", which already
             connects all of its endpoints. Kept as a single net to avoid redundant copper.",
  "detectedBy": "NET_SUBSUMED_BY_LARGER_NET"
}
```

### Errors — 6, all explicit

| Code | Count | Target |
|---|---|---|
| `FOOTPRINT_NOT_FOUND` | 3 | U1, U2, U3 |
| `PIN_NOT_FOUND` | 3 | U1, U2, U3 |

`PIN_NOT_FOUND` is raised once per component rather than once per net member —
9 members would otherwise produce 9 copies of the same fact.

**`compilable: false` is the correct and honest answer for `rc_car.json` today.**
We have no verified footprint or pinout for any of its three parts. Phase 5 will
make it compilable by supplying **explicitly labelled mocks** (`source: "mock"`),
not by relaxing this.

---

## What is deliberately *not* here

- **Placement coordinates.** Layout belongs to the compiler; a ValidatedDesign
  should compile identically regardless of layout strategy.
- **Routing/trace geometry.** Produced by tscircuit, verified by DRC afterwards.
- **Electrical protocol checks** (SCK↔MOSI, split I2C half-nets). These are
  Phase 5 validator scope per the plan. Net *de-duplication* is here because the
  schema requires de-duplicated nets; protocol correctness is a different job.
  Extension point: a `checks` module consuming the built design.
- **Anything LLM-authored.** By construction.

## Determinism

`buildValidatedDesign` is a pure function. No clocks, no randomness, no network,
no id generation. Net de-duplication sorts by member count and restores upstream
ordering for stable output. Verified by test: repeated builds of
`noise_pollution_monitor.json` serialize byte-identically.
