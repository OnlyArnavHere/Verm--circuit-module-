# Conversational modification — schema proposal (Phase 8)

**Status: PROPOSAL. Nothing here is implemented yet.**
**Date:** 2026-08-09

Two schemas for review before any code is written, per Phase 8's "propose the
intermediate schema, then build" discipline — the same sequencing as
`ValidatedDesign` in Phase 3.

Scope is deliberately one modification type: **component repositioning**.

---

## 0. A prerequisite the plan doesn't call out

**Placement is currently derived, not stored — so today there is nothing to
modify.**

`generateTscircuitSource` computes `pcbX`/`pcbY` from a grid at compile time
([`toTscircuit.js:55-91`](../server/src/compile/toTscircuit.js)):

```js
const perRow = Math.ceil(Math.sqrt(components.length));
const pcbX = -width / 2 + stepX * (col + 1);
```

`ValidatedDesign` has no placement field at all. So a repositioning transform
would have nowhere to write its result, and would be forced to reach into the
compiler — breaking the layer separation the whole project rests on.

**Proposed prerequisite:** promote placement to explicit state in
`ValidatedDesign`, with the existing grid becoming the *default generator* that
fills it for v1. The compiler then stops computing placement and simply consumes
it. This is a small change with a useful side-effect: placement becomes
inspectable and diffable between versions, which is exactly what a modification
workflow needs.

```jsonc
// ValidatedDesign, new field
"placement": {
  "source": "auto_grid" | "modified",   // provenance, same discipline as everywhere else
  "components": {
    "U3": { "x_mm": 16.67, "y_mm": 10.0, "rotation_deg": 0, "source": "auto_grid" }
  }
}
```

Per-component `source` matters: after one repositioning, `U3` is `modified`
while everything else stays `auto_grid`. A later re-layout must not silently
discard a human-requested position.

---

## 1. Structured-instruction schema

What the LLM interpretation step emits. **Bounded by construction** — it is a
small enum plus numbers, and there is no field in which tscircuit code or final
geometry could be expressed.

```jsonc
{
  "instruction_version": "1.0",
  "type": "REPOSITION_COMPONENT",        // the ONLY supported type in Phase 8

  "target": { "ref_id": "U3" },          // must exist in the ValidatedDesign

  "placement": {
    // exactly one mode; each carries only bounded, numeric/enum fields
    "mode": "edge",
    "edge": "left" | "right" | "top" | "bottom",
    "margin_mm": 5.0
  },

  "interpretation": {
    "original_request": "move the BLE module closer to the edge",
    "rationale": "U3 is the only communication-class part; 'the edge' read as nearest board edge",
    "confidence": 0.86                    // AUDIT ONLY — never a gate (same rule as Phase 6)
  }
}
```

### The four placement modes

| mode | fields | Used for |
|---|---|---|
| `edge` | `edge`, `margin_mm` | "closer to the edge", "put it on the left side" |
| `relative_to` | `ref_id`, `direction`, `distance_mm` | "next to the MCU", "away from the regulator" |
| `delta` | `dx_mm`, `dy_mm` | "move it 5mm left" |
| `absolute` | `x_mm`, `y_mm` | an explicit coordinate request |

### Where the geometry is actually computed — the load-bearing point

For `edge` and `relative_to`, **the LLM does not compute coordinates.** It names
an edge and a margin; the deterministic layer resolves that to millimetres using
the board outline and the component's real footprint dimensions.

That keeps section 1's rule intact: the model expresses *intent*, the
deterministic layer produces *geometry*. `absolute` and `delta` do let a number
through, but they are still only a **candidate** — validation can reject them,
and they are the modes to prefer least when the request is qualitative.

### Rejection is a first-class output

Anything not cleanly a repositioning is refused, not reinterpreted:

```jsonc
{
  "instruction_version": "1.0",
  "type": "UNSUPPORTED",
  "requested_change_class": "component_swap" | "net_change" | "board_constraint" | "unclear",
  "reason": "Request asks to replace the BLE module with a WiFi module. Component swaps cascade through footprint resolution and electrical validation and are out of scope for Phase 8.",
  "interpretation": { "original_request": "..." }
}
```

This mirrors `PIN_NOT_FOUND` vs `PART_CAPABILITY_MISMATCH`: an explicit
"unsupported" that terminates is more useful than a broad guess that half-works.

### Deterministic validation, before anything is applied

Nothing is trusted because the model proposed it. Each check maps to an existing
error code:

| Check | Failure |
|---|---|
| `target.ref_id` exists in this version's `ValidatedDesign` | `COMPONENT_NOT_FOUND` |
| exactly one mode, all required fields present, numbers finite | `UNSUPPORTED_COMPONENT` |
| `relative_to.ref_id` exists | `COMPONENT_NOT_FOUND` |
| resolved position keeps the whole footprint inside the board outline | `BOARD_CONSTRAINT_FAILURE` |
| resolved position does not overlap another component's courtyard | `DRC_FAILURE` (pre-check) |

The overlap pre-check is a fast reject before spending a compile. It does **not**
replace the real DRC re-run, which is authoritative.

---

## 2. Version-storage schema

**Extending the existing `Job` model, not building a parallel system.** It
already carries `version`, `parentJobId`, and the 4-slot `outputs`; what's
missing is design lineage, the request/instruction provenance, and the
`ValidatedDesign` snapshot.

```jsonc
{
  // --- lineage (new) ---
  "designId": "design_7f3a",      // stable across all versions
  "version": 2,                    // exists today
  "parentJobId": "job_...",        // exists today; the version this was derived from
  "isCurrent": true,               // newest successful version for this designId

  // --- how this version came to exist (new) ---
  "origin": {
    "kind": "upload" | "modification",
    "request": {                                  // null for kind: "upload"
      "naturalLanguage": "move the BLE module closer to the edge",
      "receivedAt": "2026-08-09T…",
      "requestedBy": "user|agent-id"
    },
    "instruction": { /* the structured instruction above, verbatim */ },
    "resolvedPlacement": {                        // what the deterministic layer computed
      "U3": { "from": { "x_mm": 33.3, "y_mm": 10 }, "to": { "x_mm": 45.0, "y_mm": 10 } }
    }
  },

  // --- the design itself (new: currently only the raw upstream payload is stored) ---
  "validatedDesign": { /* full snapshot, including placement */ },

  // --- results (outputs already exist) ---
  "outputs": { "circuit": {…}, "schematic": {…}, "pcb": {…}, "model3d": {…} },
  "validation": {
    "drc": { "ran": true, "failures": 0, "warnings": 21, "byType": {…} },
    "assertions": { "padIntegrity": true, "netsRealized": true }
  }
}
```

### Rejected modifications: recorded, but never a version

Phase 8 requires a DRC-violating move to **not** commit a new version. But
discarding the attempt loses exactly the information a user needs ("why didn't my
change apply?"). Proposal: record the attempt on the **parent** version, and do
not create a version document at all.

```jsonc
// on the parent version
"modificationAttempts": [{
  "attemptedAt": "2026-08-09T…",
  "request": { "naturalLanguage": "…" },
  "instruction": { /* structured */ },
  "outcome": "rejected",
  "rejectedBy": "drc" | "validation" | "interpretation",
  "errors": [{ "code": "DRC_FAILURE", "message": "pcb_smtpad U3.pin1 overlaps U4.pin7", … }]
}]
```

So version numbers only ever denote boards that actually compiled and passed —
`v1, v2, v3` are all real, and there are no gaps to explain.

### Immutability

Prior versions are never mutated. The only field that changes on an old version
is `isCurrent: true → false`, and `modificationAttempts` appending. A v2 that
fails leaves v1 byte-identical and still current — which the Phase 8 definition
of done requires proving.

---

## 3. Flow, and what is actually new

```
NL request + designId/version
        │
        ▼  [NEW]  LLM interpretation
  structured instruction  ──(not repositioning)──▶ UNSUPPORTED, no version
        │
        ▼  [NEW]  deterministic validation (component exists, placement well-formed)
        │
        ▼  [NEW]  deterministic transform → new ValidatedDesign with updated placement
        │
        ▼  [REUSED, unchanged] compiler → tscircuit → 4 output generators
        │
        ▼  [REUSED, Phase 5.5] DRC re-run ──(violation)──▶ REJECT, record attempt, no version
        │
        ▼  [NEW]  store as v(n+1), mark previous isCurrent:false
        │
        ▼  [REUSED] Socket.IO event + MongoDB, for other agents
```

Reused unchanged: the compiler, tscircuit, all four output generators, DRC, the
pad/net assertions, S3 upload, the socket layer.

Genuinely new: the interpretation step, the apply-transform, version storage —
plus the placement-state prerequisite in §0.

---

## 4. Open questions for review

1. **The §0 prerequisite** — promoting placement into `ValidatedDesign` touches
   Phase 3's schema and Phase 5's compiler. Confirm that's acceptable; there is
   no coherent way to do repositioning without it.
2. **Rejected attempts on the parent** (§2) versus creating a `status: rejected`
   version document. I prefer the former — version numbers stay meaningful — but
   it's a product call about what the frontend should list.
3. **`designId` for existing jobs.** Records created before this change have no
   `designId`. Backfill `designId = jobId, version = 1, isCurrent = true`, or
   leave them un-versioned?
4. **Is `absolute` mode worth having at all?** It's the one mode where the model
   emits a coordinate. Dropping it would make "the LLM never emits geometry"
   absolute rather than nearly-absolute, at the cost of rejecting "put it at
   x=20, y=15" — a request a user could reasonably make.
5. **DRC baseline.** Both POC fixtures currently produce 9–21 DRC *warnings* and
   zero failures. Confirm the blocking rule is "new `DRC_FAILURE` count > 0"
   rather than "any warning count increase" — the latter would block on advisory
   findings that v1 already has.
