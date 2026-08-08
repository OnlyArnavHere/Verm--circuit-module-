# Phase 2 spike — tscircuit headless export

Executable evidence for [`docs/FEASIBILITY_REPORT.md`](../../docs/FEASIBILITY_REPORT.md).
This is throwaway research code, **not** part of the product pipeline — it exists so
the report's claims can be re-verified rather than taken on trust.

## Run

```bash
npm ci
node export-all-four.js          # all 4 required outputs -> ./out
node determinism-and-failures.js # repeat-run stability + unknown-part behaviour
node what-varies.js              # isolates the one field that differs between runs
node real-parts.js               # fixture package strings + jlcpcb: lookups (needs network)
```

Linux / offline proof:

```bash
docker build -t tscircuit-spike .
docker run --rm --network none tscircuit-spike
```

## What each script established

| Script | Finding |
|---|---|
| `export-all-four.js` | 9/9 artifacts written as real files, headless, no browser. Identical result in `node:22-slim` with `--network none`. |
| `determinism-and-failures.js` | SVGs byte-identical across runs. Invalid footprints produce structured `*_error` elements — tscircuit does not invent footprints. |
| `what-varies.js` | The only run-to-run difference in Circuit JSON is an instance counter inside a warning **message string**. All geometry is stable. |
| `real-parts.js` | 8/10 fixture package strings fail outright; `DFN-8-EP(2x3)` fails **silently with zero pads** (report risk R1). `jlcpcb:` lookups work but need network (1.8–4.2 s/part). |

`out/` is gitignored — regenerate it by running the scripts.
