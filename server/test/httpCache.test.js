/**
 * Phase 5.6 fix #2 — component data must be cached locally, so a second run of
 * an already-resolved design makes ZERO new network calls.
 *
 * The bug: only the LCSC code and pin names were cached. Footprint geometry and
 * 3D models were fetched live from registry-api.tscircuit.com and
 * modules.easyeda.com on every compile, so "deterministic and offline" was false
 * and every build depended on third-party infrastructure staying up.
 *
 * These tests use a temp cache dir and a stubbed origin `fetch`, so they prove
 * the caching behaviour without touching the network or the committed cache.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installHttpCache } from "../src/services/httpCache.js";

const FOOTPRINT_URL = "https://registry-api.tscircuit.com/parts/C382136";
const MODEL_URL = "https://modules.easyeda.com/3dmodel/abc123";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pcb-httpcache-"));
}

/** Replace global fetch with a counting stub, and return the counter. */
function stubOrigin(body = "payload") {
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(typeof input === "string" ? input : input.url);
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  return calls;
}

test("second run makes ZERO network calls for already-cached component data", async () => {
  const dir = tempDir();
  const original = globalThis.fetch;
  try {
    // --- first run: populates the cache -----------------------------------
    let origin = stubOrigin("footprint-json");
    let cache = installHttpCache({ dir });
    const first = await (await fetch(FOOTPRINT_URL)).text();
    await fetch(MODEL_URL);
    cache.uninstall();

    assert.equal(origin.length, 2, "first run must hit the origin");
    assert.equal(cache.stats.networkCalls, 2);
    assert.equal(cache.stats.hits, 0);

    // --- second run: same requests, fresh counters -------------------------
    origin = stubOrigin("SHOULD-NOT-BE-USED");
    cache = installHttpCache({ dir });
    const second = await (await fetch(FOOTPRINT_URL)).text();
    await fetch(MODEL_URL);
    cache.uninstall();

    assert.equal(origin.length, 0, "second run must make ZERO network calls");
    assert.equal(cache.stats.networkCalls, 0);
    assert.equal(cache.stats.hits, 2);
    assert.equal(second, first, "cached body must be byte-identical to the original");
  } finally {
    globalThis.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readonly mode throws on a miss instead of silently reaching the network", async () => {
  const dir = tempDir();
  const original = globalThis.fetch;
  try {
    const origin = stubOrigin();
    const cache = installHttpCache({ dir, mode: "readonly" });

    await assert.rejects(
      () => fetch(FOOTPRINT_URL),
      /readonly.*cache miss/i,
      "an offline run must fail loudly rather than quietly fetching"
    );
    assert.equal(origin.length, 0, "no network call may be made in readonly mode");
    cache.uninstall();
  } finally {
    globalThis.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("binary payloads round-trip byte-for-byte", async () => {
  const dir = tempDir();
  const original = globalThis.fetch;
  try {
    const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x00, 0xff, 0x10, 0x99]);
    globalThis.fetch = async () => new Response(bytes, { status: 200 });

    let cache = installHttpCache({ dir });
    const a = Buffer.from(await (await fetch(MODEL_URL)).arrayBuffer());
    cache.uninstall();

    globalThis.fetch = async () => {
      throw new Error("origin must not be called");
    };
    cache = installHttpCache({ dir });
    const b = Buffer.from(await (await fetch(MODEL_URL)).arrayBuffer());
    cache.uninstall();

    assert.deepEqual([...b], [...a]);
    assert.deepEqual([...b], [...bytes], "3D model bytes must survive the cache intact");
  } finally {
    globalThis.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failed responses are NOT cached, so an outage cannot be pinned forever", async () => {
  const dir = tempDir();
  const original = globalThis.fetch;
  try {
    // Exactly the HTTP 504 seen from the real parts service during Phase 5.6.
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("gateway timeout", { status: 504 });
    };

    let cache = installHttpCache({ dir });
    const failed = await fetch(FOOTPRINT_URL);
    cache.uninstall();
    assert.equal(failed.status, 504);

    // A later run must retry rather than replay the failure.
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("recovered", { status: 200 });
    };
    cache = installHttpCache({ dir });
    const recovered = await (await fetch(FOOTPRINT_URL)).text();
    cache.uninstall();

    assert.equal(recovered, "recovered", "a transient failure must not be cached");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("non-component hosts are not cached", async () => {
  const dir = tempDir();
  const original = globalThis.fetch;
  try {
    const origin = stubOrigin();
    const cache = installHttpCache({ dir });
    await fetch("https://example.com/anything");
    await fetch("https://example.com/anything");
    cache.uninstall();

    assert.equal(origin.length, 2, "unrelated hosts pass through uncached");
    assert.equal(cache.stats.passthrough, 2);
    assert.equal(fs.readdirSync(dir).length, 0, "nothing written for unrelated hosts");
  } finally {
    globalThis.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
