/**
 * Phase 1 definition-of-done check, run against a live server.
 *
 *   1. all 4 fixtures upload -> job persisted in MongoDB
 *   2. each upload emits a "received" socket event
 *   3. a malformed payload is rejected explicitly (no job created)
 *   4. object storage round-trips a real file
 *
 * Usage: npm run verify:phase1   (server must already be running)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";
import { config } from "../src/config.js";
import { connectDb, disconnectDb } from "../src/db.js";
import { Job } from "../src/models/Job.js";
import { roundTripCheck } from "../src/services/storage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../test-fixtures");
const API = `http://localhost:${config.port}`;

const results = [];
const pass = (name, detail) => results.push({ ok: true, name, detail });
const fail = (name, detail) => results.push({ ok: false, name, detail });

const receivedEvents = [];
const socket = io(API, { transports: ["websocket"] });
socket.on("job:received", (payload) => receivedEvents.push(payload));

await new Promise((resolve, reject) => {
  socket.once("connect", resolve);
  socket.once("connect_error", (e) =>
    reject(new Error(`socket connect failed: ${e.message}`))
  );
  setTimeout(() => reject(new Error("socket connect timed out")), 5000);
});
pass("socket connects", socket.id);

await connectDb();

// --- 1 & 2: every fixture uploads, persists, and emits ------------------------
const fixtures = (await fs.readdir(fixturesDir)).filter((f) => f.endsWith(".json"));
for (const fixture of fixtures) {
  const raw = await fs.readFile(path.join(fixturesDir, fixture));
  const form = new FormData();
  form.append("design", new Blob([raw], { type: "application/json" }), fixture);

  const res = await fetch(`${API}/api/jobs`, { method: "POST", body: form });
  const body = await res.json();

  if (res.status !== 201) {
    fail(`${fixture} upload`, `HTTP ${res.status}: ${JSON.stringify(body)}`);
    continue;
  }

  const persisted = await Job.findOne({ jobId: body.jobId });
  if (!persisted) {
    fail(`${fixture} persisted`, `no Mongo record for ${body.jobId}`);
    continue;
  }

  const outputKeys = ["circuit", "schematic", "pcb", "model3d"];
  const outputsShaped = outputKeys.every((k) => k in (persisted.outputs ?? {}));

  if (!outputsShaped) {
    fail(`${fixture} outputs shape`, "job.outputs missing one of the 4 kinds");
    continue;
  }

  pass(
    `${fixture}`,
    `job ${body.jobId.slice(0, 8)} status=${persisted.status} ` +
      `components=${body.upstream.componentCount} nets=${body.upstream.netCount} ` +
      `outputs=4x null`
  );
}

// Give the socket a moment to drain, then check the events landed.
await new Promise((r) => setTimeout(r, 400));
if (receivedEvents.length >= fixtures.length) {
  pass(
    "socket job:received events",
    `${receivedEvents.length} received for ${fixtures.length} uploads`
  );
} else {
  fail(
    "socket job:received events",
    `only ${receivedEvents.length} of ${fixtures.length}`
  );
}

// --- 3: malformed input is rejected explicitly --------------------------------
const before = await Job.countDocuments();
const badRes = await fetch(`${API}/api/jobs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ schema_version: "1.0", design_name: "broken" }),
});
const badBody = await badRes.json();
const after = await Job.countDocuments();

if (badRes.status === 422 && badBody.code === "MALFORMED_UPLOAD" && after === before) {
  pass(
    "malformed payload rejected",
    `HTTP 422 ${badBody.code}, ${badBody.issues.length} issues, no job created`
  );
} else {
  fail(
    "malformed payload rejected",
    `HTTP ${badRes.status} ${badBody.code}, jobs ${before}->${after}`
  );
}

// --- 4: storage round trip ----------------------------------------------------
try {
  const rt = await roundTripCheck();
  pass("storage round-trip", `${rt.bytes} bytes write/read/verify/delete`);
} catch (error) {
  fail("storage round-trip", error.message);
}

// --- report -------------------------------------------------------------------
console.log("\nPhase 1 verification\n" + "=".repeat(60));
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log("=".repeat(60));
console.log(`${results.length - failed}/${results.length} checks passed\n`);

socket.close();
await disconnectDb();
process.exit(failed === 0 ? 0 : 1);
