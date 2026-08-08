/**
 * Phase 5 POC: push fixtures end-to-end and produce all four output files.
 *
 *   parse -> electrical checks -> de-duplicate nets -> resolve (real first,
 *   mock per field) -> compile -> tscircuit -> artifacts -> S3 -> manifest
 *
 * Usage:
 *   node scripts/run-poc.js                     # both required fixtures
 *   node scripts/run-poc.js rc_car              # one
 *   node scripts/run-poc.js --no-upload         # skip S3
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildValidatedDesign } from "../src/design/validatedDesign.js";
import { runElectricalChecks } from "../src/design/electricalChecks.js";
import { resolveComponents, resolutionSummary, isReal } from "../src/design/resolver.js";
import { compileDesign } from "../src/compile/compile.js";
import { putObject, artifactKey, STORAGE_BUCKET } from "../src/services/storage.js";
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

// Component data (footprint geometry, 3D models) is cached on disk so a re-run
// is genuinely deterministic and offline-capable. See services/httpCache.js.
const httpCache = installHttpCache({ mode: offline ? "readonly" : "readwrite" });

/**
 * Default set is deliberately two fixtures: rc_car alone would only exercise the
 * mock fallback, so a SOT-23-6-bearing fixture proves the real-resolution path.
 */
const FIXTURES = named.length > 0 ? named : ["rc_car", "smart_dustbin"];

const CONTENT_TYPES = {
  svg: "image/svg+xml",
  glb: "model/gltf-binary",
  json: "application/json",
  txt: "text/plain",
  kicad_pcb: "application/x-kicad-pcb",
  kicad_sch: "application/x-kicad-schematic",
  gbr: "application/vnd.gerber",
  drl: "application/vnd.excellon",
};
const contentTypeFor = (filename) =>
  CONTENT_TYPES[filename.split(".").pop()] ?? "application/octet-stream";

async function runFixture(name) {
  console.log(`\n${"=".repeat(74)}\n${name}\n${"=".repeat(74)}`);

  const upstream = JSON.parse(
    fs.readFileSync(path.join(fixturesDir, `${name}.json`), "utf8")
  );

  // --- validate ------------------------------------------------------------
  const electrical = runElectricalChecks(upstream);
  const validated = buildValidatedDesign(upstream);

  console.log(
    `validation: ${electrical.errors.length} electrical finding(s), ` +
      `${validated.modifications.length} recorded modification(s)`
  );
  for (const error of electrical.errors) {
    console.log(`  ${error.code.padEnd(20)} ${error.target}`);
  }

  // De-duplicated nets feed the compiler; upstream components are unchanged.
  const deduped = {
    ...upstream,
    nets: validated.design.nets.map((net) => ({
      name: net.name,
      net_class: net.net_class,
      connections: net.members.map((m) => `${m.ref_id}.${m.logicalPin}`),
    })),
  };

  // --- resolve (real first, mock per field) --------------------------------
  const resolution = await resolveComponents(upstream.components, deduped.nets);

  console.log("\npre-compile resolution (model_3d is deliberately unresolved here —");
  console.log("it is only claimed after compilation, from actual cad_components):");
  for (const [field, tally] of Object.entries(resolutionSummary(resolution.components))) {
    const parts = Object.entries(tally)
      .map(([source, count]) => `${source}=${count}`)
      .join(" ");
    console.log(`  ${field.padEnd(10)} ${parts}`);
  }

  const realFootprints = resolution.components.filter((c) =>
    isReal(c.resolution.footprint.source)
  );
  console.log(
    `\nreal footprints: ${realFootprints.length}/${resolution.components.length}` +
      (realFootprints.length
        ? ` (${realFootprints.map((c) => `${c.ref_id}=${c.resolution.footprint.lcsc ?? c.resolution.footprint.value}`).join(", ")})`
        : "")
  );

  // --- compile -------------------------------------------------------------
  const outDir = path.join(outRoot, name);
  fs.rmSync(outDir, { recursive: true, force: true });

  const compiled = await compileDesign({
    upstream: deduped,
    resolvedComponents: resolution.components,
    outDir,
  });

  console.log(
    `\ncompile: ${compiled.stats.elements} elements, ${compiled.stats.pads} pads, ` +
      `${compiled.stats.traces} traces, ${compiled.stats.cadComponents} 3D models, ${compiled.compileMs}ms`
  );
  console.log(
    `assertions: padIntegrity=${compiled.assertions.padIntegrity.ok ? "PASS" : "FAIL"} ` +
      `netsRealized=${compiled.assertions.netsRealized.ok ? "PASS" : "FAIL"}`
  );
  console.log(
    `DRC: ${compiled.drc.ran ? `${compiled.drc.total} finding(s) — ` +
      `${compiled.drc.errors.length} DRC_FAILURE, ${compiled.drc.warnings.length} warning(s)` : "did not run"}`
  );

  const real3d = resolution.components.filter((c) => c.resolution.model_3d.real).length;
  console.log(
    `3D models (confirmed from compiled output): ${real3d}/${resolution.components.length}`
  );

  // Recomputed AFTER compilation, because confirmModel3d corrects model_3d in
  // place. The manifest must carry the confirmed values, not the pre-compile ones.
  const summary = resolutionSummary(resolution.components);
  for (const error of compiled.assertions.padIntegrity.errors.slice(0, 4)) {
    console.log(`  ! ${error.message.slice(0, 100)}`);
  }
  for (const note of compiled.notes) console.log(`  note: ${note}`);

  // --- the four required outputs -------------------------------------------
  const required = ["circuit", "schematic", "pcb", "model3d"];
  console.log("\nrequired outputs:");
  const missing = [];
  for (const kind of required) {
    const artifact = compiled.artifacts[kind];
    if (artifact && fs.existsSync(artifact.path)) {
      console.log(
        `  OK   ${kind.padEnd(10)} ${artifact.filename.padEnd(22)} ${String(artifact.bytes).padStart(8)} B` +
          (artifact.additional?.length ? `  (+${artifact.additional.length} more)` : "")
      );
    } else {
      console.log(`  FAIL ${kind}`);
      missing.push(kind);
    }
  }

  // --- upload --------------------------------------------------------------
  const uploads = [];
  if (!noUpload) {
    const files = [];
    for (const kind of required) {
      const artifact = compiled.artifacts[kind];
      if (!artifact) continue;
      files.push({ kind, ...artifact });
      for (const extra of artifact.additional ?? []) files.push({ kind, ...extra });
    }

    for (const file of files) {
      const key = artifactKey({
        jobId: `poc-${name}`,
        version: 1,
        kind: file.kind,
        filename: file.filename,
      });
      const put = await putObject({
        key,
        body: fs.readFileSync(file.path),
        contentType: contentTypeFor(file.filename),
      });
      uploads.push({ kind: file.kind, key, bytes: put.bytes, sha256: file.sha256 });
    }
    console.log(`\nS3: uploaded ${uploads.length} file(s) to ${STORAGE_BUCKET}`);
  } else {
    console.log("\nS3: skipped (--no-upload)");
  }

  // --- manifest ------------------------------------------------------------
  const manifest = {
    fixture: name,
    design_name: upstream.design_name,
    generatedBy: "phase5-poc",
    bucket: noUpload ? null : STORAGE_BUCKET,

    // Per-field resolution for EVERY component — never a single mock/real flag.
    components: resolution.components.map((component) => ({
      ref_id: component.ref_id,
      part_number: component.part_number,
      package: component.package,
      resolution: Object.fromEntries(
        Object.entries(component.resolution).map(([field, value]) => [
          field,
          {
            source: value.source,
            real: value.real,
            value: value.value,
            ...(value.lcsc ? { lcsc: value.lcsc } : {}),
            ...(value.reason ? { reason: value.reason } : {}),
            ...(value.evidence ? { evidence: value.evidence } : {}),
            // Pins resolve individually: a part can have some real named pads
            // and some positional mocks, and both must be visible.
            ...(typeof value.realCount === "number"
              ? { realCount: value.realCount, totalCount: value.totalCount, perPin: value.perPin }
              : {}),
          },
        ])
      ),
    })),
    resolutionSummary: summary,

    outputs: Object.fromEntries(
      required.map((kind) => {
        const artifact = compiled.artifacts[kind];
        return [
          kind,
          artifact
            ? {
                format: artifact.format,
                filename: artifact.filename,
                bytes: artifact.bytes,
                sha256: artifact.sha256,
                s3Key: uploads.find((u) => u.kind === kind && u.sha256 === artifact.sha256)?.key ?? null,
                additional: (artifact.additional ?? []).map((a) => ({
                  filename: a.filename,
                  bytes: a.bytes,
                })),
              }
            : null,
        ];
      })
    ),

    validation: {
      electricalFindings: electrical.errors.map((e) => ({
        code: e.code,
        target: e.target,
        message: e.message,
      })),
      modifications: [...validated.modifications, ...electrical.modifications].map((m) => ({
        target: m.target,
        detectedBy: m.detectedBy,
        reason: m.reason,
      })),
      assertions: {
        padIntegrity: compiled.assertions.padIntegrity.ok,
        netsRealized: compiled.assertions.netsRealized.ok,
        failures: compiled.assertions.padIntegrity.errors.map((e) => e.message),
      },
      tscircuitErrors: compiled.tscircuitIssues.errors.length,
      drc: {
        ran: compiled.drc.ran,
        total: compiled.drc.total,
        failures: compiled.drc.errors.length,
        warnings: compiled.drc.warnings.length,
        byType: compiled.drc.byType,
      },
      model3dConfirmedFromCompiledOutput: true,
    },

    stats: compiled.stats,
    manufacturable: false,
    manufacturableReason:
      "Pin assignment is positional, not the verified pinout (pins.source = mock). " +
      "Layout and footprints may be real, but this board must not be fabricated.",
  };

  const manifestPath = path.join(outDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`manifest: ${manifestPath}`);

  return {
    name,
    manifest,
    missing,
    compiled,
    realFootprints: realFootprints.length,
    assertionsPassed: compiled.assertions.passed,
  };
}

// ---------------------------------------------------------------------------
const results = [];
for (const fixture of FIXTURES) {
  results.push(await runFixture(fixture));
}

console.log(`\n${"=".repeat(74)}\nPHASE 5 SUMMARY\n${"=".repeat(74)}`);
let ok = true;
for (const result of results) {
  const realCount = result.realFootprints;
  const total = result.manifest.components.length;
  console.log(
    `${result.name.padEnd(26)} outputs=${4 - result.missing.length}/4  ` +
      `real footprints=${realCount}/${total}  ` +
      `padAssert=${result.manifest.validation.assertions.padIntegrity ? "PASS" : "FAIL"}  ` +
      `netAssert=${result.manifest.validation.assertions.netsRealized ? "PASS" : "FAIL"}  ` +
      `3D=${result.manifest.resolutionSummary.model_3d.parts_engine ?? 0}/${total}`
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
    (offline ? "  [offline mode]" : "")
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
