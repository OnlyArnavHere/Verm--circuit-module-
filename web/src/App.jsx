import { useEffect, useState } from "react";
import { io } from "socket.io-client";

import { JOB_EVENTS, STAGES, applyJobEvent, deriveQuality, stageStates } from "./jobState.js";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const OUTPUT_KINDS = ["circuit", "schematic", "pcb", "model3d"];

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
