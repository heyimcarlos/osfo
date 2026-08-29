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
  source: Schema.Literals([
    "allowance_and_billing_ledger",
    "gmail_provider_receipts",
    "memory_commit_receipts",
    "model_access_receipts",
    "osfo_committed_turns",
    "provider_delivery_receipts",
    "task_compute_receipts",
    "workflow_instance_receipts",
  ]),
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

export const QualificationProductAuthorityRun = Schema.Struct({
  arrivalCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
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
