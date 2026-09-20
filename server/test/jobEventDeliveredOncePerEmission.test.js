/**
 * GUARD: a listener in BOTH the firehose and a per-job room receives each event
 * exactly ONCE.
 *
 * emitJobEvent used to call `io.to("jobs").emit()` and then
 * `io.to("job:<id>").emit()` as two separate emissions. Socket.IO delivers each
 * call independently, so any socket in both rooms got every event twice — and
 * both rooms is the NORMAL case: every connection auto-joins "jobs" on connect,
 * and a UI watching one job also joins "job:<id>". Observed as doubled status
 * events during Phase 10 end-to-end testing.
 *
 * Chaining (`io.to(a).to(b).emit()`) makes Socket.IO compute the union of the
 * rooms and deliver once. This test uses a real server and a real client rather
 * than asserting on the shape of the call, because the bug was in delivery
 * semantics, not in the code's appearance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { io as ioClient } from "socket.io-client";
import { initEvents, emitJobEvent } from "../src/services/events.js";

/** Boot a throwaway server on an ephemeral port with the real events wiring. */
async function withServer(fn) {
  const server = http.createServer();
  initEvents(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const client = ioClient(`http://127.0.0.1:${port}`, { transports: ["websocket"] });
  try {
    await new Promise((resolve, reject) => {
      client.on("connect", resolve);
      client.on("connect_error", reject);
    });
    return await fn(client);
  } finally {
    client.close();
    await new Promise((r) => server.close(r));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 250));

test("a socket in BOTH rooms receives each job event exactly once", async () => {
  await withServer(async (client) => {
    const jobId = "job-under-test";
    // Joins "job:<id>". The connection already auto-joined "jobs" on connect,
    // so this socket is now in both — the condition that caused the double.
    client.emit("job:subscribe", jobId);
    await new Promise((r) => client.on("job:subscribed", r));

    const received = [];
    client.on("job:compiling", (envelope) => received.push(envelope));

    emitJobEvent("job:compiling", { jobId, status: "compiling", message: "once please" });
    await settle();

    assert.equal(received.length, 1, `expected exactly 1 delivery, got ${received.length}`);
    assert.equal(received[0].jobId, jobId);
    assert.equal(received[0].message, "once please");
    assert.equal(received[0].event, "job:compiling", "envelope must still carry the event name");
    assert.ok(received[0].at, "envelope must still carry a timestamp");
  });
});

test("a firehose-only socket still receives the event, exactly once", async () => {
  // Not subscribed to any job room: other platform agents watch the firehose
  // alone and must not lose events when the rooms are chained.
  await withServer(async (client) => {
    const received = [];
    client.on("job:completed", (e) => received.push(e));

    emitJobEvent("job:completed", { jobId: "some-other-job", status: "completed" });
    await settle();

    assert.equal(received.length, 1, "firehose delivery must survive the chaining");
    assert.equal(received[0].jobId, "some-other-job");
  });
});

test("an event with no jobId still reaches the firehose once", async () => {
  await withServer(async (client) => {
    const received = [];
    client.on("job:received", (e) => received.push(e));

    emitJobEvent("job:received", { status: "received" });
    await settle();

    assert.equal(received.length, 1, "the no-jobId branch must not double or drop");
  });
});

test("a socket subscribed to a DIFFERENT job does not receive this job's event", async () => {
  // The per-job room must still scope: chaining unions the rooms, it must not
  // broadcast a job's detail to a subscriber of an unrelated job beyond the
  // firehose they already share.
  await withServer(async (client) => {
    client.emit("job:subscribe", "job-A");
    await new Promise((r) => client.on("job:subscribed", r));

    const received = [];
    client.on("job:failed", (e) => received.push(e));

    emitJobEvent("job:failed", { jobId: "job-B", status: "failed" });
    await settle();

    // Exactly one, via the firehose — never two.
    assert.equal(received.length, 1, "firehose gives one copy; the job-A room must not add another");
    assert.equal(received[0].jobId, "job-B");
  });
});
