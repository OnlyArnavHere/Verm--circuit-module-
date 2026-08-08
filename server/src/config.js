import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
// .env lives at the repo root, shared by docker-compose and the server.
dotenv.config({ path: path.resolve(here, "../../.env") });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 2 * 1024 * 1024),

  mongoUri: required("MONGO_URI"),

  storage: {
    // Empty endpoint => real AWS S3. Set => S3-compatible service (MinIO in dev).
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION ?? "us-east-1",
    bucket: required("S3_BUCKET"),
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  },
};
