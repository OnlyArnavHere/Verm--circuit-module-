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

    /**
     * Correctness of the design, as distinct from completeness of its outputs.
     *
     * `hasAllOutputs` counts files. These two say whether the board those files
     * describe is trustworthy — which is not the same question, and conflating
     * them is how "looks complete" and "is correct" came apart before (D-009,
     * D-027). Both are surfaced next to `hasAllOutputs` in `toPublicJSON()` so a
     * consumer cannot read completeness as correctness.
     *
     * `compilable` is computed from `buildValidatedDesign()` at intake: a pure,
     * offline, deterministic function, safe to run synchronously in the request
     * path. `null` only for records created before this field existed.
     */
    compilable: { type: Boolean, default: null },

    /**
     * Number of pins resolved from a MOCK source rather than a real one.
     *
     * **`null` means NOT YET RESOLVED — it must never be coerced to 0 or
     * omitted.** 0 asserts "this design has no mocked pins"; null admits nobody
     * has looked. Rendering the unknown as a clean pass is exactly the defect
     * fixed in MISSING_PINS, and the same shape as the false `real: true` bug
     * (D-027).
     *
     * Populating it requires `resolveComponents()`, which is network-bound and
     * takes seconds-to-minutes per part, so it is deliberately NOT called in the
     * request path. It stays null until an async pipeline exists (PROJECT_PLAN
     * Phase 10).
     */
    mockedPinCount: { type: Number, default: null },

    modifications: { type: [ModificationSchema], default: [] },
    // Not `errors` — Mongoose reserves that path on documents for its own
    // validation state, and shadowing it breaks document behaviour.
    validationErrors: { type: [JobErrorSchema], default: [] },

    /**
     * DRC summary for this version. `warningDelta` vs the parent is surfaced for
     * visibility but never gates — only new DRC_FAILUREs block a version.
     */
    drc: {
      ran: { type: Boolean },
      failures: { type: Number },
      warnings: { type: Number },
      warningDelta: { type: Number },
      byType: { type: Schema.Types.Mixed },
    },
    statusHistory: { type: [StatusEventSchema], default: [] },

    /** Conversational change requests create a new version, never an overwrite. */
    version: { type: Number, default: 1 },
    parentJobId: { type: String, default: null, index: true },

    // --- design lineage (Phase 8) -------------------------------------------
    /** Stable across every version of one design. Backfilled to jobId for v1. */
    designId: { type: String, index: true },
    /** Newest successful version for this designId. Only ever flipped to false. */
    isCurrent: { type: Boolean, default: true, index: true },

    /**
     * How this version came to exist. For a modification this carries the raw
     * request, the interpreted instruction, and the resolved placement delta —
     * the same provenance discipline applied everywhere else in this project.
     */
    origin: {
      kind: { type: String, enum: ["upload", "modification"], default: "upload" },
      request: {
        naturalLanguage: { type: String },
        receivedAt: { type: Date },
        requestedBy: { type: String },
      },
      instruction: { type: Schema.Types.Mixed },
      interpretedBy: { type: String },
      resolvedPlacement: { type: Schema.Types.Mixed },
    },

    /** Full ValidatedDesign snapshot for this version, including placement. */
    validatedDesign: { type: Schema.Types.Mixed },

    /**
     * Modification attempts that were REJECTED, recorded on the version they were
     * attempted against. Deliberately not stored as version documents: a version
     * number always denotes a complete, artifact-bearing, DRC-passed board, so
     * there are no gaps in the sequence to explain.
     */
    modificationAttempts: {
      type: [
        new Schema(
          {
            attemptedAt: { type: Date, default: Date.now },
            request: { type: Schema.Types.Mixed },
            instruction: { type: Schema.Types.Mixed },
            outcome: { type: String, enum: ["rejected"], default: "rejected" },
            rejectedBy: {
              type: String,
              enum: ["interpretation", "validation", "drc", "assertions"],
            },
            // Not `errors` — Mongoose reserves that path on documents (D-005).
            rejectionErrors: { type: [Schema.Types.Mixed], default: [] },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

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
    designId: this.designId ?? this.jobId,
    designName: this.designName,
    status: this.status,
    version: this.version,
    isCurrent: this.isCurrent,
    parentJobId: this.parentJobId,
    origin: this.origin,
    drc: this.drc,
    modificationAttempts: this.modificationAttempts,
    outputs: this.outputs,
    hasAllOutputs: this.hasAllOutputs(),
    // Deliberately adjacent to hasAllOutputs: that field counts files and reads
    // like a green light. These two are the correctness signal beside it.
    // mockedPinCount === null means "not yet resolved", NOT "none" — see the
    // schema comment. Use `?? null` rather than `|| 0` so a real 0 and an
    // unresolved null stay distinguishable.
    compilable: this.compilable ?? null,
    mockedPinCount: this.mockedPinCount ?? null,
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
