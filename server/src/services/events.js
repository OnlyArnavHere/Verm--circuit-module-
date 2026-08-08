import { Server } from "socket.io";
import { config } from "../config.js";

let io = null;

/**
 * Rooms:
 *   "jobs"        — firehose; other platform agents watch this for all activity.
 *   "job:<jobId>" — per-job stream; the dev frontend joins the job it uploaded.
 */
export function initEvents(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: config.corsOrigin, methods: ["GET", "POST"] },
  });

  io.on("connection", (socket) => {
    socket.join("jobs");

    socket.on("job:subscribe", (jobId) => {
      if (typeof jobId === "string" && jobId.length > 0) {
        socket.join(`job:${jobId}`);
        socket.emit("job:subscribed", { jobId });
      }
    });

    socket.on("job:unsubscribe", (jobId) => {
      if (typeof jobId === "string") socket.leave(`job:${jobId}`);
    });
  });

  return io;
}

/**
 * Emit a job lifecycle event. Fans out to both the per-job room and the firehose
 * so live UIs and background agents see the same payload.
 * Socket delivery is best-effort — MongoDB remains the durable record.
 */
export function emitJobEvent(event, payload) {
  if (!io) return;
  const envelope = { event, at: new Date().toISOString(), ...payload };
  io.to("jobs").emit(event, envelope);
  if (payload?.jobId) io.to(`job:${payload.jobId}`).emit(event, envelope);
}

export function getIo() {
  return io;
}
