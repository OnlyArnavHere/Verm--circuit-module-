import http from "node:http";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { connectDb, disconnectDb } from "./db.js";
import { initEvents } from "./services/events.js";
import { checkBucketReachable, STORAGE_BUCKET } from "./services/storage.js";

async function main() {
  await connectDb();
  console.log(`[db] connected: ${config.mongoUri}`);

  // Warn loudly but don't refuse to boot — intake still works without storage,
  // and /health reports the real state.
  try {
    await checkBucketReachable();
    console.log(`[storage] bucket reachable: ${STORAGE_BUCKET}`);
  } catch (error) {
    console.warn(
      `[storage] WARNING bucket "${STORAGE_BUCKET}" unreachable: ${error.message}`
    );
  }

  const app = createApp();
  const server = http.createServer(app);
  initEvents(server);

  server.listen(config.port, () => {
    console.log(`[api] listening on http://localhost:${config.port}`);
    console.log(`[socket.io] ready (cors origin: ${config.corsOrigin})`);
  });

  const shutdown = async (signal) => {
    console.log(`\n[${signal}] shutting down`);
    server.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[fatal]", error);
  process.exit(1);
});
