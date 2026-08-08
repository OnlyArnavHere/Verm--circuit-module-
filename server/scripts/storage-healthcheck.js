/**
 * Phase 1 storage proof: write a dummy file, read it back, verify the bytes,
 * delete it. Run with `npm run storage:healthcheck` from server/.
 */
import { roundTripCheck, STORAGE_BUCKET } from "../src/services/storage.js";
import { config } from "../src/config.js";

try {
  console.log(
    `[storage] round-trip against bucket "${STORAGE_BUCKET}" via ${config.storage.endpoint ?? "AWS S3"}`
  );
  const result = await roundTripCheck();
  console.log(
    `[storage] OK — wrote/read/deleted ${result.bytes} bytes at ${result.key}`
  );
  console.log(`[storage] sha256=${result.checksumSha256}`);
  process.exit(0);
} catch (error) {
  console.error(`[storage] FAILED — ${error.message}`);
  process.exit(1);
}
