import mongoose from "mongoose";
import {
  JOB_STATUS,
  JOB_STATUS_VALUES,
  OUTPUT_KIND_VALUES,
  ERROR_CODES,
  SEVERITY,
} from "./constants.js";

const { Schema } = mongoose;

/**
 * A generated artifact that exists as a real file in object storage.
 * `storageKey` is the authoritative reference; `url` is a convenience mirror and
 * may be a short-lived presigned link, so never treat it as durable.
 */
const ArtifactRefSchema = new Schema(
  {
    kind: { type: String, enum: OUTPUT_KIND_VALUES, required: true },
    format: { type: String, required: true }, // e.g. "svg", "kicad_pcb", "glb"
    storageKey: { type: String, required: true },
    bucket: { type: String, required: true },
    bytes: { type: Number },
    contentType: { type: String },
    checksumSha256: { type: String },
    generatedAt: { type: Date, default: Date.now },
    /**
     * True when the file's *content* is placeholder/stub data rather than a real
     * derived result. Phase 5 permits stub content but requires it be labeled
     * honestly — this flag is that label, and `mockReason` must explain it.
     */
    mocked: { type: Boolean, default: false },
    mockReason: { type: String },
  },
  { _id: false }
);

/**
 * Section 5: any time the validator "corrects" upstream data, the original value,
 * the correction, and the reason are recorded. Corrections are never silent.
 */
const ModificationSchema = new Schema(
  {
    target: { type: String, required: true }, // e.g. "nets.SPI_10"
    field: { type: String },
    originalValue: { type: Schema.Types.Mixed },
    correctedValue: { type: Schema.Types.Mixed },
    reason: { type: String, required: true },
    detectedBy: { type: String }, // rule id, e.g. "SCK_TIED_TO_DATA_PIN"
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const JobErrorSchema = new Schema(
  {
    code: { type: String, enum: ERROR_CODES, required: true },
    severity: {
      type: String,
      enum: Object.values(SEVERITY),
      default: SEVERITY.ERROR,
    },
    message: { type: String, required: true },
    target: { type: String }, // what it's about, e.g. "U7.SCK"
    detail: { type: Schema.Types.Mixed },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const StatusEventSchema = new Schema(
  {
    status: { type: String, enum: JOB_STATUS_VALUES, required: true },
    message: { type: String },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const JobSchema = new Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    designName: { type: String, required: true },
    status: {
      type: String,
      enum: JOB_STATUS_VALUES,
      default: JOB_STATUS.RECEIVED,
      index: true,
    },

    /** Verbatim Hardware Agent payload. Never mutated — corrections live in `modifications`. */
    upstream: {
      schemaVersion: { type: String },
      sourceFilename: { type: String },
      payload: { type: Schema.Types.Mixed, required: true },
      receivedAt: { type: Date, default: Date.now },
    },

    /**
     * The four required outputs. Present and explicitly null from job creation so
     * the shape is stable for consumers before anything populates it.
     */
    outputs: {
      circuit: { type: ArtifactRefSchema, default: null },
      schematic: { type: ArtifactRefSchema, default: null },
      pcb: { type: ArtifactRefSchema, default: null },
      model3d: { type: ArtifactRefSchema, default: null },
    },

    modifications: { type: [ModificationSchema], default: [] },
    // Not `errors` — Mongoose reserves that path on documents for its own
    // validation state, and shadowing it breaks document behaviour.
    validationErrors: { type: [JobErrorSchema], default: [] },
    statusHistory: { type: [StatusEventSchema], default: [] },

    /** Conversational change requests create a new version, never an overwrite. */
    version: { type: Number, default: 1 },
    parentJobId: { type: String, default: null, index: true },

    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

/** True only when all four required outputs are real files. */
JobSchema.methods.hasAllOutputs = function hasAllOutputs() {
  return OUTPUT_KIND_VALUES.every((kind) => Boolean(this.outputs?.[kind]));
};

JobSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    jobId: this.jobId,
    designName: this.designName,
    status: this.status,
    version: this.version,
    parentJobId: this.parentJobId,
    outputs: this.outputs,
    hasAllOutputs: this.hasAllOutputs(),
    modifications: this.modifications,
    validationErrors: this.validationErrors,
    statusHistory: this.statusHistory,
    upstream: {
      schemaVersion: this.upstream?.schemaVersion,
      sourceFilename: this.upstream?.sourceFilename,
      receivedAt: this.upstream?.receivedAt,
      componentCount: this.upstream?.payload?.components?.length ?? 0,
      netCount: this.upstream?.payload?.nets?.length ?? 0,
    },
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const Job = mongoose.model("Job", JobSchema);
