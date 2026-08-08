import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const OUTPUT_KINDS = ["circuit", "schematic", "pcb", "model3d"];

export default function App() {
  const [health, setHealth] = useState(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [events, setEvents] = useState([]);

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
    const record = (name) => (payload) =>
      setEvents((prev) => [{ name, payload, at: new Date() }, ...prev].slice(0, 50));

    socket.on("connect", () => record("socket:connected")({ id: socket.id }));
    socket.on("job:received", record("job:received"));
    socket.on("job:status", record("job:status"));
    socket.on("job:failed", record("job:failed"));
    socket.on("job:completed", record("job:completed"));

    return () => socket.close();
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (!file) return;

    setBusy(true);
    setError(null);
    setJob(null);

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

  return (
    <div className="wrap">
      <header>
        <h1>PCB &amp; Circuit Design Agent — dev upload</h1>
        <p>
          Phase 1: plumbing only. Uploads create a job record and emit a socket
          event. No design generation runs yet.
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
          Try any file from <code>test-fixtures/</code>.
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
          <h2>Job created</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            <strong>{job.designName}</strong> · {job.jobId} · status{" "}
            <strong>{job.status}</strong> · {job.upstream.componentCount}{" "}
            components / {job.upstream.netCount} nets
          </p>

          {job.intakeWarnings?.length > 0 && (
            <p className="warn">
              {job.intakeWarnings.length} intake warning(s):{" "}
              {job.intakeWarnings.join("; ")}
            </p>
          )}

          <div className="outputs">
            {OUTPUT_KINDS.map((kind) => (
              <div className="output" key={kind}>
                <div className="k">{kind}</div>
                <div className="v">
                  {job.outputs?.[kind]
                    ? `${job.outputs[kind].format}${job.outputs[kind].mocked ? " (mocked)" : ""}`
                    : "not generated"}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <h2>Socket events</h2>
        <ul className="events">
          {events.length === 0 && (
            <li className="empty">Waiting for events…</li>
          )}
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
