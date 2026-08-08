/**
 * Circuit JSON hashes differ between runs while the rendered SVGs are stable.
 * Find exactly which fields vary — this decides whether the pipeline can be
 * called deterministic, and what has to be normalized before hashing/caching.
 */
import { CircuitRunner } from "@tscircuit/eval";

const SOURCE = `
circuit.add(
  <board width="100mm" height="60mm">
    <chip name="U1" footprint="soic16" pcbX={-30} />
    <chip name="U2" footprint="qfn48"  pcbX={0} />
    <trace from=".U1 > .pin1" to=".U2 > .pin1" />
  </board>
)
`;

async function build() {
  const runner = new CircuitRunner();
  await runner.execute(SOURCE);
  await runner.renderUntilSettled();
  return runner.getCircuitJson();
}

const a = await build();
const b = await build();

console.log(`element counts: ${a.length} vs ${b.length}`);

// Compare element-by-element, reporting differing keys.
const differingKeys = new Map();
const limit = Math.min(a.length, b.length);

for (let i = 0; i < limit; i++) {
  const ea = a[i];
  const eb = b[i];

  if (ea.type !== eb.type) {
    console.log(`ORDER DIFFERS at index ${i}: ${ea.type} vs ${eb.type}`);
    continue;
  }

  for (const key of new Set([...Object.keys(ea), ...Object.keys(eb)])) {
    const va = JSON.stringify(ea[key]);
    const vb = JSON.stringify(eb[key]);
    if (va !== vb) {
      const label = `${ea.type}.${key}`;
      if (!differingKeys.has(label)) {
        differingKeys.set(label, { count: 0, example: [va, vb] });
      }
      differingKeys.get(label).count += 1;
    }
  }
}

if (differingKeys.size === 0) {
  console.log("\nNo per-element differences. Variation must be ordering or key order.");
} else {
  console.log("\nFields that differ between two runs:\n" + "=".repeat(72));
  for (const [label, info] of [...differingKeys].sort((x, y) => y[1].count - x[1].count)) {
    console.log(`${String(info.count).padStart(4)}x  ${label}`);
    console.log(`        run1: ${String(info.example[0]).slice(0, 100)}`);
    console.log(`        run2: ${String(info.example[1]).slice(0, 100)}`);
  }
}

// Does a stable re-serialization make them equal?
const normalize = (cj) =>
  JSON.stringify(
    cj.map((el) =>
      Object.fromEntries(Object.entries(el).sort(([k1], [k2]) => k1.localeCompare(k2)))
    )
  );
console.log(`\nkey-sorted serialization equal: ${normalize(a) === normalize(b)}`);
