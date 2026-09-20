/**
 * Before/after of the job panel, against the LIVE backend.
 *
 * The DOM is not rendered -- no browser automation is installed in this repo
 * (no Playwright, Puppeteer or jsdom). So this drives the exact module the
 * component drives, web/src/jobState.js, over a real socket connected to the
 * real server, and prints the JSX's own text for each state.
 *
 *   BEFORE = the committed App.jsx: four listeners (one of which, `job:status`,
 *            the server never emits) that only append to an event log. setJob()
 *            is called once, from the POST response. The panel is therefore
 *            frozen at that response for the life of the job.
 *   AFTER  = the new App.jsx: the eight real events, each folded through
 *            applyJobEvent, rendered through deriveQuality.
 *
 * Both panels are rendered from the SAME live event stream, at the same
 * moments, so the comparison is controlled: one run, one job, two readers.
 */
import fs from "node:fs";
import { io } from "socket.io-client";

import {
  JOB_EVENTS,
  STAGES,
  applyJobEvent,
  deriveQuality,
  stageIndex,
} from "../src/jobState.js";

const API = "http://localhost:4000";
const OUTPUT_KINDS = ["circuit", "schematic", "pcb", "model3d"];
const FIXTURE = "C:/Users/ARNAV/workspace/pcb-agent/test-fixtures/rc_car.json";

/* ------------------------------------------------------------------ */
/* Text of the two renders. Mirrors the JSX literally, branch for branch. */

/** The committed App.jsx's job panel: `git show HEAD:web/src/App.jsx`, :117-144. */
function renderBefore(job) {
  if (!job) return "  (no panel)";
  const outputs = OUTPUT_KINDS.map((kind) => {
    const v = job.outputs?.[kind]
      ? `${job.outputs[kind].format}${job.outputs[kind].mocked ? " (mocked)" : ""}`
      : "not generated";
    return `    ${kind.padEnd(10)} ${v}`;
  });
  return [
    "  JOB CREATED",
    `    ${job.designName} · ${job.jobId} · status ${job.status} · ` +
      `${job.upstream.componentCount} components / ${job.upstream.netCount} nets`,
    "    OUTPUTS",
    ...outputs,
  ].join("\n");
}

/** The new App.jsx's job panel. */
function renderAfter(job, links) {
  if (!job) return "  (no panel)";
  const q = deriveQuality(job);
  const current = stageIndex(job.status);

  const strip = STAGES.map((stage, i) => {
    const state =
      job.status === "failed"
        ? i <= current || current === -1 ? "failed" : "todo"
        : i < current ? "done" : i === current ? "active" : "todo";
    const mark = { done: "[x]", active: "[>]", failed: "[!]", todo: "[ ]" }[state];
    return `${mark}${stage}`;
  }).join(" ");

  const findings = q.findings.map(
    (f) => `    ${{ ok: "OK  ", warn: "WARN", pending: "... " }[f.level]} ${f.label}: ${f.detail}`,
  );

  const outputs = OUTPUT_KINDS.map((kind) => {
    const a = job.outputs?.[kind];
    let v;
    if (!a) v = job.status === "completed" ? "not produced" : "pending";
    else if (links[kind]) v = `${a.format}${a.mocked ? " (mocked)" : ""} ↓ (link)`;
    else v = `${a.format}${a.mocked ? " (mocked)" : ""}`;
    return `    ${kind.padEnd(10)} ${v}`;
  });

  return [
    `  JOB — ${q.headline}`,
    `    ${job.designName} · ${job.jobId} · ` +
      `${job.upstream.componentCount} components / ${job.upstream.netCount} nets`,
    `    ${strip}`,
    job.lastMessage ? `    ${job.lastMessage.slice(0, 96)}` : null,
    `    DESIGN FINDINGS  [block class: quality.${q.worst}]`,
    ...findings,
    q.caveat ? `    ${q.caveat}` : null,
    "    OUTPUTS",
    ...outputs,
  ]
    .filter(Boolean)
    .join("\n");
}

/* ------------------------------------------------------------------ */

const socket = io(API, { transports: ["websocket", "polling"] });
await new Promise((r) => socket.on("connect", r));

// The committed App.jsx's four listeners. Registered BEFORE the POST, as the
// component registers them on mount, so `job:received` is not missed by
// accident -- the point is which events it can hear, not which it raced.
const beforeHeard = [];
for (const name of ["job:received", "job:status", "job:failed", "job:completed"]) {
  socket.on(name, (p) => beforeHeard.push({ name, jobId: p?.jobId }));
}

const buf = fs.readFileSync(FIXTURE);
const form = new FormData();
form.append("design", new Blob([buf], { type: "application/json" }), "rc_car.json");

const res = await fetch(`${API}/api/jobs`, { method: "POST", body: form });
const posted = await res.json();
if (!res.ok) { console.error("POST failed", posted); process.exit(1); }

// BEFORE holds the POST response and never changes it again: its socket
// handlers call setEvents only. AFTER folds every event in.
const before = posted;
let after = posted;
const links = {};

console.log(`POST /api/jobs -> HTTP ${res.status}  jobId=${posted.jobId}\n`);
console.log("=".repeat(78));
console.log(`STAGE 0 — immediately after POST (both identical here)`);
console.log("=".repeat(78));
console.log("BEFORE:\n" + renderBefore(before));
console.log("\nAFTER:\n" + renderAfter(after, links));

let done = false;
let seq = 0;

for (const name of JOB_EVENTS) {
  socket.on(name, (payload) => {
    if (payload?.jobId !== posted.jobId) return;
    after = applyJobEvent(after, name, payload);

    console.log("\n" + "=".repeat(78));
    console.log(`STAGE ${++seq} — server emitted ${name}`);
    console.log("=".repeat(78));
    console.log("BEFORE:\n" + renderBefore(before));
    console.log("\nAFTER:\n" + renderAfter(after, links));

    if (name === "job:completed" || name === "job:failed") done = true;
  });
}

const t0 = Date.now();
while (!done && Date.now() - t0 < 900000) await new Promise((r) => setTimeout(r, 1000));
await new Promise((r) => setTimeout(r, 1000));

/* The presign effect, exactly as the component runs it. */
if (after.status === "completed") {
  for (const kind of OUTPUT_KINDS) {
    if (!after.outputs?.[kind]) continue;
    const r = await fetch(`${API}/api/jobs/${posted.jobId}/outputs/${kind}/url`);
    if (!r.ok) continue;
    const body = await r.json();
    if (body.url) links[kind] = body.url;
  }
  console.log("\n" + "=".repeat(78));
  console.log("STAGE " + ++seq + " — presigned links resolved (the new effect)");
  console.log("=".repeat(78));
  console.log("BEFORE:\n" + renderBefore(before));
  console.log("\nAFTER:\n" + renderAfter(after, links));

  console.log("\n--- do the links actually resolve? (real GET, byte counts) ---");
  for (const kind of OUTPUT_KINDS) {
    if (!links[kind]) { console.log(`  ${kind.padEnd(10)} NO LINK`); continue; }
    const r = await fetch(links[kind]);
    const bytes = (await r.arrayBuffer()).byteLength;
    console.log(`  ${kind.padEnd(10)} HTTP ${r.status}  ${bytes.toLocaleString()} bytes`);
  }
}

console.log(`\n--- events the committed App.jsx would have heard for this job: ` +
  `${[...new Set(beforeHeard.filter((e) => e.jobId === posted.jobId).map((e) => e.name))].join(", ") || "(none)"}`);
console.log(`--- server truth: ` +
  JSON.stringify(await (await fetch(`${API}/api/jobs/${posted.jobId}`)).json()
    .then((j) => ({ status: j.status, compilable: j.compilable,
      mockedPinCount: j.mockedPinCount, hasAllOutputs: j.hasAllOutputs }))));
socket.close();
