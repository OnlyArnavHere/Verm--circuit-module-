import { useEffect, useState } from "react";
import { io } from "socket.io-client";

import { JOB_EVENTS, STAGES, applyJobEvent, deriveQuality, stageStates } from "./jobState.js";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const OUTPUT_KINDS = ["circuit", "schematic", "pcb", "model3d"];

/**
 * The outputs that can actually be LOOKED at. `pcb` is a KiCad board file --
 * there is no browser-native renderer for it, so it stays download-only rather
 * than getting a pane that would never paint anything.
 */
const PREVIEWABLE = [
  { kind: "circuit", label: "Circuit diagram" },
  { kind: "schematic", label: "Schematic" },
  { kind: "model3d", label: "3D model" },
];

/**
 * Pinned, not floating: an unpinned CDN URL can change under a build that was
 * never re-verified. Google's own host, as the component's docs publish it.
 */
const MODEL_VIEWER_CDN =
  "https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js";

/**
 * Load <model-viewer> once, on demand.
 *
 * Module-level so a remount does not re-inject the tag, and a promise so two
 * near-simultaneous activations share the one load instead of racing. Nothing
 * here runs until someone actually opens the 3D tab -- the script is ~950KB
 * before the GLB itself is even requested.
 */
let modelViewerLoad = null;
function loadModelViewer() {
  if (modelViewerLoad) return modelViewerLoad;
  modelViewerLoad = new Promise((resolve, reject) => {
    if (customElements.get("model-viewer")) return resolve();
    const tag = document.createElement("script");
    tag.type = "module";
    tag.src = MODEL_VIEWER_CDN;
    tag.onload = () => resolve();
    tag.onerror = () => {
      // Let a later attempt retry rather than caching the failure forever.
      modelViewerLoad = null;
      reject(new Error("model-viewer failed to load from the CDN"));
    };
    document.head.appendChild(tag);
  });
  return modelViewerLoad;
}

/**
 * Inline previews for the three viewable outputs.
 *
 * Deliberately rendered BELOW the findings block, never in place of it. A board
 * that looks plausible in a preview can still be one that must not be
 * fabricated, so the preview is allowed to show what happened -- it is not
 * allowed to be the only thing the eye lands on. `hasFindings` restates that in
 * the pane itself, for anyone who scrolled past the block above.
 */
function OutputPreviews({ job, links, hasFindings }) {
  const available = PREVIEWABLE.filter(({ kind }) => job.outputs?.[kind] && links[kind]);
  // Default to the first CHEAP artifact. Never the GLB: selecting a tab is what
  // triggers its fetch, so defaulting to it would pull 16MB on render.
  const [tab, setTab] = useState(available[0]?.kind ?? null);
  const [viewer, setViewer] = useState("idle"); // idle | loading | ready | error

  useEffect(() => {
    // Only now -- on a real activation of the 3D tab -- does anything 3D load.
    if (tab !== "model3d" || viewer !== "idle") return;
    let cancelled = false;
    setViewer("loading");
    loadModelViewer().then(
      () => !cancelled && setViewer("ready"),
      () => !cancelled && setViewer("error"),
    );
    return () => { cancelled = true; };
  }, [tab, viewer]);

  if (available.length === 0) return null;
  const active = available.find((a) => a.kind === tab) ?? available[0];
  const url = links[active.kind];
  const artifact = job.outputs[active.kind];

  return (
    <div className="previews">
      <div className="tabs">
        {available.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            className={`tab ${kind === active.kind ? "on" : ""}`}
            onClick={() => setTab(kind)}
          >
            {label}
            {kind === "model3d" && viewer === "idle" ? " ·" : ""}
          </button>
        ))}
      </div>

      {hasFindings && (
        <p className="preview-note">
          This renders a design that has findings above — seeing it does not
          make it manufacturable.
        </p>
      )}

      <div className="stage-view">
        {active.kind === "model3d" ? (
          viewer === "ready" ? (
            // src is set ONLY once the script is ready and this tab is active,
            // so the GLB is never fetched on a page that no one opened it on.
            <model-viewer
              // NOT the presigned S3 URL. model-viewer fetches with fetch(),
              // and the bucket sends no Access-Control-Allow-Origin, so S3
              // directly is blocked by the browser. This route streams the same
              // bytes through the API, which the web origin is allowed to call.
              src={`${API}/api/jobs/${job.jobId}/outputs/model3d/raw`}
              alt={`3D model of ${job.designName}`}
              camera-controls=""
              auto-rotate=""
              shadow-intensity="1"
              style={{ width: "100%", height: "420px", background: "#0b0d11" }}
            />
          ) : (
            <p className="muted preview-status">
              {viewer === "error"
                ? "3D viewer could not load from the CDN. The download link below still works."
                : `Loading the 3D viewer, then ${(artifact.bytes / 1048576).toFixed(1)}MB of model…`}
            </p>
          )
        ) : (
          // <img>, NOT <object>, and the reason is measured rather than stylistic:
          // the schematic SVG ships with width/height but NO viewBox. <object>
          // embeds it as a document, which then renders at its fixed 1200x600
          // and clips in any narrower pane. <img> treats it as a replaced
          // element and scales it by its intrinsic aspect ratio, so it fits in
          // both cases -- circuit (has a viewBox) and schematic (does not).
          // <img> also needs no CORS to display, unlike the GLB below.
          <img
            src={url}
            alt={`${active.label} for ${job.designName}`}
            className="svg-view"
          />
        )}
      </div>

      <p className="muted preview-meta">
        {active.label} · {artifact.format} ·{" "}
        {artifact.bytes?.toLocaleString()} bytes ·{" "}
        <a href={url} target="_blank" rel="noreferrer">
          download ↓
        </a>
      </p>
    </div>
  );
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [events, setEvents] = useState([]);
  const [links, setLinks] = useState({});

  useEffect(() => {
    const load = () =>
      fetch(`${API}/health`)
        .then((r) => r.json())
        .then(setHealth)
        .catch(() => setHealth({ ok: false, unreachable: true }));
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  // Join the firehose so events show up regardless of which job produced them.
  useEffect(() => {
    const socket = io(API, { transports: ["websocket", "polling"] });

    socket.on("connect", () =>
      setEvents((prev) => [{ name: "socket:connected", payload: { id: socket.id }, at: new Date() }, ...prev].slice(0, 50)),
    );

    // Every event the server ACTUALLY emits. The previous code listened for
    // `job:status`, which nothing has ever emitted, so the five per-stage
    // events went unheard and the panel never moved off `received`.
    for (const name of JOB_EVENTS) {
      socket.on(name, (payload) => {
        setEvents((prev) => [{ name, payload, at: new Date() }, ...prev].slice(0, 50));
        // The panel must track the job, not just log that something happened.
        // Functional form: this effect runs once, so a handler reading `job`
        // from the closure would see the first render's value forever.
        setJob((current) => applyJobEvent(current, name, payload));
      });
    }

    return () => socket.close();
  }, []);

  // On a terminal job, resolve a real presigned link per artifact. The API has
  // provided this all along at /outputs/:kind/url; the panel simply never used
  // it and showed only the format.
  useEffect(() => {
    if (!job || job.status !== "completed") return;
    let cancelled = false;
    (async () => {
      const found = {};
      for (const kind of OUTPUT_KINDS) {
        if (!job.outputs?.[kind]) continue;
        try {
          const res = await fetch(`${API}/api/jobs/${job.jobId}/outputs/${kind}/url`);
          if (!res.ok) continue;
          const body = await res.json();
          if (body.url) found[kind] = body.url;
        } catch {
          // A link that will not resolve is simply not offered. Better no link
          // than one that 404s.
        }
      }
      if (!cancelled) setLinks(found);
    })();
    return () => { cancelled = true; };
  }, [job?.status, job?.jobId]);

  async function submit(event) {
    event.preventDefault();
    if (!file) return;

    setBusy(true);
    setError(null);
    setJob(null);
    setLinks({});

    try {
      const body = new FormData();
      body.append("design", file);
      const res = await fetch(`${API}/api/jobs`, { method: "POST", body });
      const data = await res.json();
      if (!res.ok) setError(data);
      else setJob(data);
    } catch (err) {
      setError({ code: "NETWORK", message: err.message });
    } finally {
      setBusy(false);
    }
  }

  const quality = deriveQuality(job);
  const states = stageStates(job);

  return (
    <div className="wrap">
      <header>
        <h1>PCB &amp; Circuit Design Agent — dev upload</h1>
        <p>
          Uploading a Hardware Agent JSON creates a job and runs the full
          pipeline: validate → resolve → compile → generate → upload. Status
          updates live over Socket.IO; finished artifacts are downloadable
          below.
        </p>
      </header>

      <section className="panel">
        <h2>Services</h2>
        <div className="status">
          <span className={`dot ${health?.mongo?.up ? "up" : "down"}`} />
          MongoDB {health?.mongo?.up ? "connected" : "unavailable"}
        </div>
        <div className="status">
          <span className={`dot ${health?.storage?.up ? "up" : "down"}`} />
          Object storage{" "}
          {health?.storage?.up
            ? `reachable (${health.storage.bucket})`
            : `unavailable${health?.storage?.error ? ` — ${health.storage.error}` : ""}`}
        </div>
      </section>

      <section className="panel">
        <h2>Upload Hardware Agent JSON</h2>
        <form className="row" onSubmit={submit}>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button type="submit" disabled={!file || busy}>
            {busy ? "Uploading…" : "Create job"}
          </button>
        </form>
        <p className="muted" style={{ marginBottom: 0, marginTop: 10 }}>
          Try any file from <code>test-fixtures/</code>. A typical design takes
          about a minute.
        </p>
      </section>

      {error && (
        <section className="panel">
          <h2>Rejected</h2>
          <p className="err">
            <strong>{error.code}</strong> — {error.message}
          </p>
          {error.issues?.length > 0 && (
            <pre>{error.issues.map((i) => `• ${i}`).join("\n")}</pre>
          )}
        </section>
      )}

      {job && (
        <section className="panel">
          <h2>
            Job — {quality.headline}
          </h2>
          <p className="muted" style={{ marginTop: 0 }}>
            <strong>{job.designName}</strong> · {job.jobId} ·{" "}
            {job.upstream?.componentCount} components / {job.upstream?.netCount} nets
          </p>

          <ol className="stages">
            {STAGES.map((stage, i) => (
              <li key={stage} className={`stage ${states[i]}`}>
                {stage}
              </li>
            ))}
            {job.status === "failed" && <li className="stage failed">failed</li>}
          </ol>

          {job.lastMessage && <p className="muted">{job.lastMessage}</p>}

          {/*
            Design quality, kept VISUALLY SEPARATE from pipeline status. A job
            that finished is not thereby a good board, and the two must never
            read the same.
          */}
          <div className={`quality ${quality.worst}`}>
            <h3>Design findings</h3>
            <ul>
              {quality.findings.map((f) => (
                <li key={f.label} className={f.level}>
                  <strong>{f.label}:</strong> {f.detail}
                </li>
              ))}
            </ul>
            {quality.caveat && <p className="caveat">{quality.caveat}</p>}
          </div>

          {job.intakeWarnings?.length > 0 && (
            <p className="warn">
              {job.intakeWarnings.length} intake warning(s):{" "}
              {job.intakeWarnings.join("; ")}
            </p>
          )}

          <div className="outputs">
            {OUTPUT_KINDS.map((kind) => {
              const artifact = job.outputs?.[kind];
              return (
                <div className="output" key={kind}>
                  <div className="k">{kind}</div>
                  <div className="v">
                    {!artifact ? (
                      job.status === "completed" ? "not produced" : "pending"
                    ) : links[kind] ? (
                      <a href={links[kind]} target="_blank" rel="noreferrer">
                        {artifact.format}
                        {artifact.mocked ? " (mocked)" : ""} ↓
                      </a>
                    ) : (
                      `${artifact.format}${artifact.mocked ? " (mocked)" : ""}`
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/*
            Below the findings block by construction. The download grid above is
            kept as-is -- previews are in ADDITION to the links, not a
            replacement for them.
          */}
          <OutputPreviews job={job} links={links} hasFindings={quality.worst === "warn"} />
        </section>
      )}

      <section className="panel">
        <h2>Socket events</h2>
        <ul className="events">
          {events.length === 0 && <li className="empty">Waiting for events…</li>}
          {events.map((e, i) => (
            <li key={i}>
              <span className="t">{e.at.toLocaleTimeString()}</span>
              <span className="name">{e.name}</span>
              <span className="muted">
                {e.payload?.designName ?? e.payload?.jobId ?? ""}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
