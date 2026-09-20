/**
 * Phase 5 POC: push fixtures end-to-end and produce all four output files.
 *
 *   parse -> electrical checks -> de-duplicate nets -> resolve (real first,
 *   mock per field) -> compile -> tscircuit -> artifacts -> S3 -> manifest
 *
 * This is now a THIN CLI WRAPPER over src/design/pipeline.js. The pipeline was
 * extracted so the job worker and this script run the same code rather than two
 * implementations that drift; everything below is argv parsing, console
 * reporting and the pass/fail bar, which are CLI concerns and stay here.
 *
 * Usage:
 *   node scripts/run-poc.js                     # both required fixtures
 *   node scripts/run-poc.js rc_car              # one
 *   node scripts/run-poc.js --no-upload         # skip S3
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline, PipelineError } from "../src/design/pipeline.js";
import { STORAGE_BUCKET } from "../src/services/storage.js";
import { installHttpCache, httpCacheStats } from "../src/services/httpCache.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../test-fixtures");
const outRoot = path.resolve(here, "../../artifacts");

const args = process.argv.slice(2);
const noUpload = args.includes("--no-upload");
// --offline proves the cache is complete: any request not already on disk throws
// rather than silently reaching the network.
const offline = args.includes("--offline");
const named = args.filter((a) => !a.startsWith("--"));

const httpCache = installHttpCache({ mode: offline ? "readonly" : "readwrite" });

/**
 * Default set is deliberately two fixtures: rc_car alone would only exercise the
 * mock fallback, so a SOT-23-6-bearing fixture proves the real-resolution path.
 */
const FIXTURES = named.length > 0 ? named : ["rc_car", "smart_dustbin"];

/** Console reporting, at exactly the boundaries the pipeline announces. */
function stageLogger() {
  return (stage, d) => {
    switch (stage) {
      case "validated":
        console.log(
          `validation: ${d.electricalFindings} electrical finding(s), ` +
            `${d.modifications} recorded modification(s), compilable=${d.compilable}`,
        );
        break;
      case "resolved":
        console.log(`\nreal footprints: ${d.realFootprints}/${d.totalComponents}` +
          `  (mocked pins on ${d.mockedPinCount})`);
        break;
      case "compiled":
        console.log(
          `\ncompile: ${d.elements} elements, ${d.pads} pads, ${d.traces} traces, ` +
            `${d.cadComponents} 3D models, ${d.compileMs}ms`,
        );
        console.log(
          `assertions: padIntegrity=${d.padIntegrity ? "PASS" : "FAIL"} ` +
            `netsRealized=${d.netsRealized ? "PASS" : "FAIL"}`,
        );
        console.log(
          `DRC: ${d.drc ? `${d.drc.total} finding(s) — ${d.drc.failures} DRC_FAILURE` : "did not run"}`,
        );
        break;
      case "generated":
        console.log("\nrequired outputs:");
        for (const p of d.produced) {
          console.log(`  OK   ${p.kind.padEnd(10)} ${p.filename.padEnd(22)} ${String(p.bytes).padStart(8)} B`);
        }
        for (const kind of d.missing) console.log(`  FAIL ${kind}`);
        break;
      case "uploaded":
        console.log(`\nS3: uploaded ${d.count} file(s) to ${d.bucket}`);
        break;
      default:
        break;
    }
  };
}

async function runFixture(name) {
  console.log(`\n${"=".repeat(74)}\n${name}\n${"=".repeat(74)}`);
  const upstream = JSON.parse(fs.readFileSync(path.join(fixturesDir, `${name}.json`), "utf8"));

  const result = await runPipeline({
    upstream,
    outDir: path.join(outRoot, name),
    // The POC has no job; it names its own namespace. Unchanged from before the
    // extraction, when artifactKey was already called with `poc-<name>`.
    jobId: `poc-${name}`,
    version: 1,
    upload: !noUpload,
    onStage: stageLogger(),
  });

  if (noUpload) console.log("\nS3: skipped (--no-upload)");
  console.log(`manifest: ${path.join(outRoot, name, "manifest.json")}`);

  return { name, ...result, assertionsPassed: result.compiled.assertions.passed };
}

// ---------------------------------------------------------------------------
const results = [];
for (const fixture of FIXTURES) {
  try {
    results.push(await runFixture(fixture));
  } catch (error) {
    if (error instanceof PipelineError) {
      console.log(`\nFAILED at ${error.stage}: ${error.message}`);
      results.push({ name: fixture, failedStage: error.stage, missing: ["circuit", "schematic", "pcb", "model3d"], realFootprints: 0, assertionsPassed: false });
      continue;
    }
    throw error;
  }
}

console.log(`\n${"=".repeat(74)}\nPHASE 5 SUMMARY\n${"=".repeat(74)}`);
let ok = true;
for (const result of results) {
  if (result.failedStage) {
    console.log(`${result.name.padEnd(26)} FAILED at ${result.failedStage}`);
    ok = false;
    continue;
  }
  const total = result.manifest.components.length;
  console.log(
    `${result.name.padEnd(26)} outputs=${4 - result.missing.length}/4  ` +
      `real footprints=${result.realFootprints}/${total}  ` +
      `padAssert=${result.manifest.validation.assertions.padIntegrity ? "PASS" : "FAIL"}  ` +
      `netAssert=${result.manifest.validation.assertions.netsRealized ? "PASS" : "FAIL"}  ` +
      `3D=${result.manifest.resolutionSummary.model_3d.parts_engine ?? 0}/${total}`,
  );
  // Producing four files is not success if the board they describe failed its
  // integrity assertions — that is precisely the "looks fine, is wrong" outcome
  // the assertions exist to catch.
  if (result.missing.length > 0 || !result.assertionsPassed) ok = false;
}

// The plan's explicit bar: a fully-mocked run is not a success when real
// resolution was available.
const anyReal = results.some((r) => r.realFootprints > 0);
if (!anyReal) {
  console.log("\nFAIL: no component resolved a real footprint — refusing to call this a success.");
  ok = false;
}

const cache = httpCacheStats();
console.log(
  `\ncomponent-data cache: ${cache.entries} entries, ${(cache.bytes / 1e6).toFixed(1)} MB` +
    `  |  this run: ${httpCache.stats.hits} hit(s), ${httpCache.stats.networkCalls} network call(s)` +
    (offline ? "  [offline mode]" : ""),
);
if (httpCache.stats.missedUrls.length > 0) {
  // Anything listed here was NOT served from cache. If it recurs on every run it
  // is a response that failed and was therefore (correctly) not cached.
  const hosts = {};
  for (const url of httpCache.stats.missedUrls) {
    const host = new URL(url).hostname;
    hosts[host] = (hosts[host] ?? 0) + 1;
  }
  console.log(`  cache misses by host: ${JSON.stringify(hosts)}`);
  console.log(`  first miss: ${httpCache.stats.missedUrls[0].slice(0, 110)}`);
}

console.log(ok ? "\nAll required outputs produced." : "\nIncomplete.");
httpCache.uninstall();
process.exit(ok ? 0 : 1);
