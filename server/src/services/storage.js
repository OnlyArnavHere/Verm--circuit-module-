import crypto from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config.js";

const { bucket } = config.storage;

const { accessKeyId, secretAccessKey } = config.storage;

/**
 * Omitting `credentials` entirely makes the SDK use its default provider chain
 * (shared config file, SSO, container/instance IAM role). Passing a half-filled
 * credentials object instead would hard-fail, so only set it when both are present.
 */
export const s3 = new S3Client({
  region: config.storage.region,
  endpoint: config.storage.endpoint,
  forcePathStyle: config.storage.forcePathStyle,
  ...(accessKeyId && secretAccessKey
    ? { credentials: { accessKeyId, secretAccessKey } }
    : {}),
});

export const STORAGE_BUCKET = bucket;

/** Canonical layout for generated artifacts, so keys stay predictable across phases. */
export function artifactKey({ jobId, version = 1, kind, filename }) {
  return `jobs/${jobId}/v${version}/${kind}/${filename}`;
}

export async function putObject({ key, body, contentType }) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const checksumSha256 = crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex");

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  return { bucket, key, bytes: buffer.length, contentType, checksumSha256 };
}

export async function getObject(key) {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function deleteObject(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** Short-lived download link for the frontend / other agents. */
export async function presignedUrl(key, expiresIn = 3600) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn }
  );
}

/** Cheap reachability probe used by /health. Does not write. */
export async function checkBucketReachable() {
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  return true;
}

/**
 * Full write→read→verify→delete round trip. This is the Phase 1 proof that
 * storage credentials actually work before Phase 5 depends on them.
 */
export async function roundTripCheck() {
  const key = `_healthcheck/${Date.now()}-${crypto.randomUUID()}.txt`;
  const payload = `pcb-circuit-agent storage round-trip ${new Date().toISOString()}`;

  const put = await putObject({
    key,
    body: payload,
    contentType: "text/plain",
  });
  const readBack = (await getObject(key)).toString("utf8");
  await deleteObject(key);

  if (readBack !== payload) {
    throw new Error(
      `Storage round-trip mismatch for ${key}: wrote ${payload.length} bytes, read back ${readBack.length}`
    );
  }

  return { key, bytes: put.bytes, checksumSha256: put.checksumSha256 };
}
