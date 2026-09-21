import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import { Job } from "../models/Job.js";
import { JOB_STATUS } from "../models/constants.js";
import { checkIntakeShape } from "../upstream/intakeCheck.js";
import { buildValidatedDesign } from "../design/validatedDesign.js";
import { emitJobEvent } from "../services/events.js";
import { enqueueJob } from "../services/jobRunner.js";
import { presignedUrl, getObjectStream } from "../services/storage.js";
import { config } from "../config.js";

export const jobsRouter = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

/**
 * POST /api/jobs
 * Accepts a Hardware Agent JSON document, either as a multipart file field
 * named "design" or as a raw application/json body.
 *
 * Phase 1 stops at `received` — no generation is kicked off yet.
 */
jobsRouter.post("/", upload.single("design"), async (req, res, next) => {
  try {
    let payload;
    let sourceFilename = null;

    if (req.file) {
      sourceFilename = req.file.originalname;
      try {
        payload = JSON.parse(req.file.buffer.toString("utf8"));
      } catch (error) {
        return res.status(400).json({
          code: "MALFORMED_UPLOAD",
          message: `Uploaded file is not valid JSON: ${error.message}`,
          issues: [],
        });
      }
    } else if (req.body && Object.keys(req.body).length > 0) {
      payload = req.body;
    } else {
      return res.status(400).json({
        code: "MALFORMED_UPLOAD",
        message:
          'No design provided. Send a multipart file field named "design" or a JSON body.',
        issues: [],
      });
    }

    const check = checkIntakeShape(payload);
    if (!check.ok) {
      // Rejected before a job exists — nothing to persist, nothing to emit.
      return res.status(422).json({
        code: check.code,
        message: check.message,
        issues: check.issues,
      });
    }

    // Intake answered "is this shaped like a design?". This answers "is the
    // design itself sound?" — a separate question, and the one a consumer needs
    // before trusting any artifact. Safe to run synchronously: buildValidatedDesign
    // is a pure function with no clock, randomness, network or I/O.
    //
    // Deliberately NOT running the rest of the pipeline here -- it is handed to
    // the serial worker below, and mockedPinCount stays null ("not yet resolved")
    // until that worker fills it in.
    //
    // The real reason is RESPONSE TIME, not per-part cost. Measured with warm
    // caches, resolveComponents is 0.04-0.12s -- effectively free. The pipeline
    // is ~100% compileDesign: 25-91s, of which tscircuit eval is 23-26s and
    // artifact generation 2-65s. Cold, resolveComponents adds roughly 5.1s per
    // uncached part, so a fully-cold design is ~70-135s end to end. Any of those
    // numbers is far too long to hold an HTTP connection open, which is why this
    // returns 201 immediately and the work continues in the background.
    //
    // (An earlier version of this comment said resolveComponents was
    // "network-bound at seconds-to-minutes per part" and gave that as the sole
    // justification. That was true against a cold cache and is now misleading:
    // it points at the wrong stage, and an investigation nearly concluded from
    // it that resolution was the bottleneck.)
    let compilable = null;
    let validationErrors = [];
    try {
      const validated = buildValidatedDesign(payload);
      compilable = validated.compilable;
      validationErrors = validated.errors;
    } catch (error) {
      // A validator crash must not masquerade as a clean design. Leaving
      // compilable null keeps it honestly unknown rather than defaulting to a
      // pass, and the upload still succeeds so the payload is not lost.
      compilable = null;
      validationErrors = [];
      console.error(`buildValidatedDesign threw for job intake: ${error.message}`);
    }

    const jobId = crypto.randomUUID();
    const job = await Job.create({
      jobId,
      designName: check.designName,
      status: JOB_STATUS.RECEIVED,
      compilable,
      // Requires resolveComponents(); stays null until an async pipeline runs it.
      mockedPinCount: null,
      validationErrors,
      upstream: {
        schemaVersion: check.schemaVersion,
        sourceFilename,
        payload,
        receivedAt: new Date(),
      },
      statusHistory: [
        {
          status: JOB_STATUS.RECEIVED,
          message:
            `Accepted ${payload.components.length} components / ${payload.nets.length} nets. ` +
            `Design validated at intake (compilable=${compilable}, ${validationErrors.length} error(s)). ` +
            `No generation performed.`,
        },
      ],
    });

    emitJobEvent("job:received", {
      jobId: job.jobId,
      designName: job.designName,
      status: job.status,
      componentCount: payload.components.length,
      netCount: payload.nets.length,
      warnings: check.warnings,
    });

    // Hand off to the in-process serial worker and respond immediately. The
    // queue is in memory: a restart loses anything still queued, and Mongo stays
    // the durable record of what actually happened.
    const { queued } = enqueueJob(job.jobId);

    return res.status(201).json({
      ...job.toPublicJSON(),
      intakeWarnings: check.warnings,
      queuePosition: queued,
    });
  } catch (error) {
    return next(error);
  }
});

/** GET /api/jobs — newest first. Readable by other platform agents. */
jobsRouter.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const filter = req.query.status ? { status: req.query.status } : {};
    const jobs = await Job.find(filter).sort({ createdAt: -1 }).limit(limit);
    return res.json({
      count: jobs.length,
      jobs: jobs.map((job) => job.toPublicJSON()),
    });
  } catch (error) {
    return next(error);
  }
});

jobsRouter.get("/:jobId", async (req, res, next) => {
  try {
    const job = await Job.findOne({ jobId: req.params.jobId });
    if (!job) {
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: `No job ${req.params.jobId}` });
    }
    return res.json(job.toPublicJSON());
  } catch (error) {
    return next(error);
  }
});

/** The verbatim upstream document, for reproducing a job later. */
jobsRouter.get("/:jobId/upstream", async (req, res, next) => {
  try {
    const job = await Job.findOne({ jobId: req.params.jobId });
    if (!job) {
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: `No job ${req.params.jobId}` });
    }
    return res.json(job.upstream.payload);
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /api/jobs/:jobId/outputs/:kind/raw
 * Stream an artifact through this origin instead of redirecting to S3.
 *
 * WHY THIS EXISTS, measured not assumed: the bucket sends no
 * `Access-Control-Allow-Origin`. A presigned URL is fine for a download link
 * and fine for <img>, because neither is CORS-restricted -- but <model-viewer>
 * fetches the GLB with fetch(), which is. Pointed straight at S3 the 3D preview
 * is blocked by the browser on a build that compiled perfectly.
 *
 * Serving it from here puts it behind the cors() middleware the API already
 * configures for the web origin. The alternative is a CORS policy on the
 * bucket itself, which is the better production answer but mutates shared
 * infrastructure; this keeps the fix in the repo and reversible.
 */
jobsRouter.get("/:jobId/outputs/:kind/raw", async (req, res, next) => {
  try {
    const job = await Job.findOne({ jobId: req.params.jobId });
    if (!job) {
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: `No job ${req.params.jobId}` });
    }

    const artifact = job.outputs?.[req.params.kind];
    if (!artifact) {
      return res.status(409).json({
        code: "OUTPUT_NOT_READY",
        message: `Output "${req.params.kind}" has not been generated for job ${job.jobId}.`,
      });
    }

    const object = await getObjectStream(artifact.storageKey);
    res.setHeader("Content-Type", artifact.contentType ?? object.ContentType ?? "application/octet-stream");
    if (object.ContentLength) res.setHeader("Content-Length", String(object.ContentLength));
    // Immutable: an artifact is written once under a versioned key.
    res.setHeader("Cache-Control", "private, max-age=3600, immutable");

    // Pipe rather than buffer -- a 16MB GLB must not be held in memory whole.
    object.Body.on("error", next);
    return object.Body.pipe(res);
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /api/jobs/:jobId/outputs/:kind/url
 * Presigned download link for a generated artifact. Used for the download
 * links and for <img> previews, neither of which is CORS-restricted.
 */
jobsRouter.get("/:jobId/outputs/:kind/url", async (req, res, next) => {
  try {
    const job = await Job.findOne({ jobId: req.params.jobId });
    if (!job) {
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: `No job ${req.params.jobId}` });
    }

    const artifact = job.outputs?.[req.params.kind];
    if (!artifact) {
      return res.status(409).json({
        code: "OUTPUT_NOT_READY",
        message: `Output "${req.params.kind}" has not been generated for job ${job.jobId}.`,
      });
    }

    return res.json({
      kind: artifact.kind,
      format: artifact.format,
      mocked: artifact.mocked,
      url: await presignedUrl(artifact.storageKey),
    });
  } catch (error) {
    return next(error);
  }
});
