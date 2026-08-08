import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import multer from "multer";
import { config } from "./config.js";
import { jobsRouter } from "./routes/jobs.js";
import { checkBucketReachable, STORAGE_BUCKET } from "./services/storage.js";

export function createApp() {
  const app = express();

  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: config.maxUploadBytes }));

  /** Reports real dependency state so a broken bucket or DB can't hide until Phase 5. */
  app.get("/health", async (_req, res) => {
    const mongoUp = mongoose.connection.readyState === 1;

    let storageUp = false;
    let storageError = null;
    try {
      await checkBucketReachable();
      storageUp = true;
    } catch (error) {
      storageError = error.message;
    }

    const ok = mongoUp && storageUp;
    res.status(ok ? 200 : 503).json({
      ok,
      phase: 1,
      mongo: { up: mongoUp },
      storage: { up: storageUp, bucket: STORAGE_BUCKET, error: storageError },
    });
  });

  app.use("/api/jobs", jobsRouter);

  app.use((_req, res) => {
    res.status(404).json({ code: "NOT_FOUND", message: "No such route." });
  });

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      return res.status(413).json({
        code: "MALFORMED_UPLOAD",
        message: `Upload rejected: ${error.message}`,
      });
    }
    if (error?.type === "entity.too.large") {
      return res
        .status(413)
        .json({ code: "MALFORMED_UPLOAD", message: "Payload too large." });
    }
    if (error instanceof SyntaxError && "body" in error) {
      return res.status(400).json({
        code: "MALFORMED_UPLOAD",
        message: `Request body is not valid JSON: ${error.message}`,
      });
    }

    console.error("[error]", error);
    return res.status(500).json({
      code: "INTERNAL_ERROR",
      message:
        config.env === "production" ? "Internal server error." : error.message,
    });
  });

  return app;
}
