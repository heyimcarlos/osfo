import { Schema } from "effect";

import { qualificationAuthoritySources } from "./authority-sources";

export const QualificationAuthoritySource = Schema.Literals(qualificationAuthoritySources);
export type QualificationAuthoritySource = typeof QualificationAuthoritySource.Type;

export const QualificationProductAuthorityInvocation = Schema.Struct({
  executionId: Schema.String,
  manifestChecksum: Schema.String,
  planChecksum: Schema.String,
  requestArtifactChecksum: Schema.String,
  requestArtifactId: Schema.String,
});

export const QualificationProductAuthorityMissing = Schema.Struct({
  status: Schema.Literal("MISSING"),
  missingSources: Schema.Array(
    Schema.Struct({
      detail: Schema.String,
      source: QualificationAuthoritySource,
    }),
  ),
});

export const QualificationProductAuthoritySourceChunkInvocation = Schema.Struct({
  ...QualificationProductAuthorityInvocation.fields,
  chunkIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runId: Schema.String,
  source: QualificationAuthoritySource,
});
export type QualificationProductAuthoritySourceChunkSource =
  typeof QualificationProductAuthoritySourceChunkInvocation.Type.source;

export const QualificationProductAuthoritySourceChunkComplete = Schema.Struct({
  recordCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  source: QualificationAuthoritySource,
  status: Schema.Literal("COMPLETE"),
  streamChunkIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const QualificationProductAuthoritySourceChunkPending = Schema.Struct({
  retryAtEpochMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  source: QualificationAuthoritySource,
  status: Schema.Literal("PENDING"),
});

export const QualificationProductAuthoritySourceBundleComplete = Schema.Struct({
  recordCounts: Schema.Array(
    Schema.Struct({
      recordCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      source: QualificationAuthoritySource,
    }),
  ),
  status: Schema.Literal("COMPLETE"),
  streamChunkIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const QualificationProductAuthoritySourceBundlePending = Schema.Struct({
  pendingSources: Schema.Array(QualificationAuthoritySource),
  retryAtEpochMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  status: Schema.Literal("PENDING"),
});

export const QualificationProductAuthorityEvaluationInvocation = Schema.Struct({
  ...QualificationProductAuthorityInvocation.fields,
  productAuthorityInventoryChecksum: Schema.String,
  productAuthorityStreams: Schema.Array(
    Schema.Struct({
      artifactPrefix: Schema.String,
      chunkCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      recordCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      source: QualificationAuthoritySource,
      terminalChecksum: Schema.String,
    }),
  ),
});

export const QualificationProductAuthorityEvaluationComplete = Schema.Struct({
  report: Schema.Json,
  status: Schema.Literal("COMPLETE"),
  streams: Schema.Array(
    Schema.Struct({
      artifactPrefix: Schema.String,
      canonicalDigest: Schema.String,
      chunkCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      component: Schema.String,
      recordCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      sourceVersion: Schema.String,
      terminalChecksum: Schema.String,
      verificationVersion: Schema.Literal("qualification-owner-stream-v1"),
    }),
  ),
});

export const QualificationProductAuthorityRun = Schema.Struct({
  arrivalCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  chunkStartsAtEpochMs: Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  chunkCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  firstStreamChunkIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runId: Schema.String,
});

export const QualificationProductAuthorityReady = Schema.Struct({
  runs: Schema.Array(QualificationProductAuthorityRun),
  sources: Schema.Array(QualificationAuthoritySource),
  status: Schema.Literal("READY"),
  totalArrivalChunks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const QualificationProductAuthorityPreflight = Schema.Union([
  QualificationProductAuthorityMissing,
  QualificationProductAuthorityReady,
]);

export const QualificationProductAuthorityExecution = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("COMPLETE"),
  }),
  Schema.Struct({
    status: Schema.Literal("MISSING"),
    missingSources: Schema.Array(
      Schema.Struct({
        detail: Schema.String,
        source: QualificationAuthoritySource,
      }),
    ),
  }),
]);

export const QualificationProductAuthorityArrivalChunk = Schema.Struct({
  artifactChecksum: Schema.String,
  artifactId: Schema.String,
  chunkIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  firstArrivalIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  recordCount: Schema.Int.check(Schema.isGreaterThan(0)),
  runId: Schema.String,
  status: Schema.Literal("COMPLETE"),
  streamChunkIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type QualificationProductAuthorityInvocation =
  typeof QualificationProductAuthorityInvocation.Type;
