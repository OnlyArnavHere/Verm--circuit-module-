import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import { Job } from "../models/Job.js";
import { JOB_STATUS } from "../models/constants.js";
import { checkIntakeShape } from "../upstream/intakeCheck.js";
import { emitJobEvent } from "../services/events.js";
import { presignedUrl } from "../services/storage.js";
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

    const jobId = crypto.randomUUID();
    const job = await Job.create({
      jobId,
      designName: check.designName,
      status: JOB_STATUS.RECEIVED,
      upstream: {
        schemaVersion: check.schemaVersion,
        sourceFilename,
        payload,
        receivedAt: new Date(),
      },
      statusHistory: [
        {
          status: JOB_STATUS.RECEIVED,
          message: `Accepted ${payload.components.length} components / ${payload.nets.length} nets. No generation performed (Phase 1).`,
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

    return res.status(201).json({
      ...job.toPublicJSON(),
      intakeWarnings: check.warnings,
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
 * GET /api/jobs/:jobId/outputs/:kind/url
 * Presigned download link for a generated artifact. Returns 409 until Phase 5
 * actually populates outputs.
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
