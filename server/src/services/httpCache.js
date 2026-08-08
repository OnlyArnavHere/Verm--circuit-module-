/**
 * On-disk HTTP cache for component data fetched during compilation.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Our own caches only held the LCSC code (`parts-cache.json`) and pin names
 * (`pinout-cache.json`). The footprint GEOMETRY and the 3D MODELS were still
 * fetched live on every compile — from `registry-api.tscircuit.com` (tscircuit's
 * parts engine) and `modules.easyeda.com` (3D bodies). So the claim that a
 * re-run was deterministic and offline was false: identical input still
 * depended on two third-party services being up and unchanged.
 *
 * That is not just a purity concern. Community JLCPCB-data infrastructure has
 * been taken down before at JLCPCB's request, so a local copy is also what keeps
 * an already-resolved design buildable if the upstream service disappears.
 *
 * This follows the same pattern as the `jlcparts` project: fetch once, then
 * query locally.
 *
 * ── Approach ────────────────────────────────────────────────────────────────
 * Wrapping `fetch` rather than tscircuit's parts engine is deliberate: the 3D
 * models are downloaded by `circuit-json-to-gltf`, not by the parts engine, so
 * a parts-engine-level cache would miss them. One interception point covers all
 * component data fetched during a compile.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const HTTP_CACHE_DIR = path.resolve(here, "../../data/http-cache");

/** Hosts whose responses are component data worth persisting. */
const CACHEABLE_HOSTS = [
  "registry-api.tscircuit.com",
  "modules.easyeda.com",
  "jlcsearch.tscircuit.com",
  "easyeda.com",
];

const isCacheable = (url) => {
  try {
    return CACHEABLE_HOSTS.some((host) => new URL(url).hostname.endsWith(host));
  } catch {
    return false;
  }
};

const keyFor = (url, init) => {
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  return crypto.createHash("sha256").update(`${method} ${url} ${body}`).digest("hex");
};

const metaPath = (dir, key) => path.join(dir, `${key}.json`);
const bodyPath = (dir, key) => path.join(dir, `${key}.bin`);

/**
 * Install the cache by wrapping `globalThis.fetch`.
 *
 * @param {object} options
 * @param {string} [options.dir]
 * @param {"readwrite"|"readonly"} [options.mode]
 *   `readonly` refuses to make any network call and throws on a cache miss —
 *   used by the test that proves a second run needs zero new requests.
 * @returns {{stats: object, uninstall: () => void}}
 */
export function installHttpCache({ dir = HTTP_CACHE_DIR, mode = "readwrite" } = {}) {
  fs.mkdirSync(dir, { recursive: true });

  const originalFetch = globalThis.fetch;
  const stats = {
    hits: 0,
    misses: 0,
    networkCalls: 0,
    passthrough: 0,
    missedUrls: [],
    mode,
  };

  globalThis.fetch = async function cachedFetch(input, init) {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));

    if (!isCacheable(url)) {
      stats.passthrough += 1;
      if (mode === "readonly") {
        throw new Error(`[httpCache readonly] blocked non-cacheable request: ${url}`);
      }
      return originalFetch(input, init);
    }

    const key = keyFor(url, init);
    const meta = metaPath(dir, key);
    const body = bodyPath(dir, key);

    if (fs.existsSync(meta) && fs.existsSync(body)) {
      stats.hits += 1;
      const stored = JSON.parse(fs.readFileSync(meta, "utf8"));
      return new Response(fs.readFileSync(body), {
        status: stored.status,
        statusText: stored.statusText,
        headers: stored.headers,
      });
    }

    stats.misses += 1;
    stats.missedUrls.push(url);

    if (mode === "readonly") {
      throw new Error(
        `[httpCache readonly] cache miss, refusing to hit the network: ${url}`
      );
    }

    stats.networkCalls += 1;
    const response = await originalFetch(input, init);

    // Only successful responses are persisted; caching an error would pin a
    // transient failure permanently.
    if (!response.ok) return response;

    const buffer = Buffer.from(await response.clone().arrayBuffer());
    fs.writeFileSync(body, buffer);
    fs.writeFileSync(
      meta,
      `${JSON.stringify(
        {
          url,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(
            [...response.headers.entries()].filter(([name]) =>
              ["content-type", "content-length"].includes(name.toLowerCase())
            )
          ),
          bytes: buffer.length,
          cachedAt: new Date().toISOString(),
        },
        null,
        2
      )}\n`
    );

    return new Response(buffer, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  return {
    stats,
    uninstall() {
      globalThis.fetch = originalFetch;
    },
  };
}

export function httpCacheStats(dir = HTTP_CACHE_DIR) {
  if (!fs.existsSync(dir)) return { entries: 0, bytes: 0, dir };
  const files = fs.readdirSync(dir);
  const bins = files.filter((f) => f.endsWith(".bin"));
  const bytes = bins.reduce((total, f) => total + fs.statSync(path.join(dir, f)).size, 0);
  return { entries: bins.length, bytes, dir };
}
