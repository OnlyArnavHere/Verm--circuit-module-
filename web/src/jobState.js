/**
 * Job panel state: the reducer and the quality read-out, kept OUT of the
 * component so both the UI and a verification driver run the same code.
 *
 * Two bugs this replaces:
 *   1. App.jsx listened for `job:status`, which nothing has ever emitted. The
 *      server emits one event per stage -- job:validating, job:resolving,
 *      job:compiling, job:generating, job:uploading -- and all five were unheard.
 *   2. The panel rendered the POST response frozen in place. Socket handlers
 *      only appended to an event log and never updated the job, so a job that
 *      ran to `completed` with four real artifacts still displayed
 *      `status: received` and "not generated" forever.
 */

/** Pipeline stages, in order. Mirrors the server's JOB_STATUS. */
export const STAGES = [
  "received",
  "validating",
  "resolving",
  "compiling",
  "generating",
  "uploading",
  "completed",
];

/** Every event the server actually emits. `job:status` is NOT one of them. */
export const JOB_EVENTS = [
  "job:received",
  "job:validating",
  "job:resolving",
  "job:compiling",
  "job:generating",
  "job:uploading",
  "job:completed",
  "job:failed",
];

/**
 * Fold a socket event into the rendered job.
 *
 * Ignores events for other jobs: the UI is on the firehose, so it sees every
 * job on the server, and without this filter another user's run would overwrite
 * the panel. Returns the SAME object when nothing applies, so React can skip
 * a re-render.
 */
export function applyJobEvent(job, eventName, payload) {
  if (!job || !payload?.jobId || payload.jobId !== job.jobId) return job;
  if (!JOB_EVENTS.includes(eventName)) return job;

  const next = { ...job, status: payload.status ?? job.status };

  // Carried on the transitions that compute them. Guarded with `!== undefined`
  // because `mockedPinCount: 0` and `compilable: false` are both meaningful
  // values that `??` or a truthiness check would silently drop.
  if (payload.compilable !== undefined) next.compilable = payload.compilable;
  if (payload.mockedPinCount !== undefined) next.mockedPinCount = payload.mockedPinCount;
  if (payload.outputs !== undefined) next.outputs = payload.outputs;
  if (payload.message) next.lastMessage = payload.message;
  return next;
}

/**
 * What the pipeline state means, as distinct from whether the DESIGN is good.
 *
 * `completed` means the pipeline ran to the end. It does NOT mean the board is
 * manufacturable, and the panel must never let the two read the same. A job can
 * finish with all four artifacts while being non-compilable and having
 * positional pins -- which is the normal case today, not an edge one.
 */
export function deriveQuality(job) {
  if (!job) return null;

  const terminal = job.status === "completed" || job.status === "failed";
  const outputs = job.outputs ?? {};
  const producedCount = ["circuit", "schematic", "pcb", "model3d"].filter((k) => outputs[k]).length;

  const findings = [];

  // null means "not yet resolved" and must NEVER render as "0 mocked pins" --
  // an unknown shown as a clean pass is the defect this field exists to avoid.
  if (job.mockedPinCount === null || job.mockedPinCount === undefined) {
    findings.push({
      level: terminal ? "warn" : "pending",
      label: "Pin resolution",
      detail: "not yet resolved",
    });
  } else if (job.mockedPinCount > 0) {
    findings.push({
      level: "warn",
      label: "Positional pins",
      detail:
        `${job.mockedPinCount} component(s) have mocked (positional) pins — ` +
        `this board must not be fabricated`,
    });
  } else {
    findings.push({ level: "ok", label: "Pin resolution", detail: "all pins resolved from real pinouts" });
  }

  if (job.compilable === false) {
    findings.push({
      level: "warn",
      label: "Validation",
      detail: "design did not validate as compilable",
    });
  } else if (job.compilable === true) {
    findings.push({ level: "ok", label: "Validation", detail: "design validates as compilable" });
  } else {
    findings.push({ level: "pending", label: "Validation", detail: "not yet known" });
  }

  if (terminal && job.status !== "failed") {
    findings.push({
      level: producedCount === 4 ? "ok" : "warn",
      label: "Outputs",
      detail: `${producedCount}/4 produced`,
    });
  }

  const worst = findings.some((f) => f.level === "warn")
    ? "warn"
    : findings.some((f) => f.level === "pending")
      ? "pending"
      : "ok";

  return {
    findings,
    worst,
    terminal,
    // The headline. Deliberately never just "Completed".
    headline:
      job.status === "failed"
        ? "Failed"
        : !terminal
          ? "In progress"
          : worst === "ok"
            ? "Completed — no findings"
            : "Completed with findings",
    caveat:
      terminal && job.status !== "failed"
        ? "“Completed” means the pipeline ran to the end, not that the board is manufacturable."
        : null,
  };
}

/** Index of a stage, for the progress strip. -1 when failed or unknown. */
export function stageIndex(status) {
  return STAGES.indexOf(status);
}
