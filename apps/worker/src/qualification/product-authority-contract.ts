import { Schema } from "effect";

import { qualificationAuthoritySources } from "./authority-sources";

export const QualificationAuthoritySource = Schema.Literals(qualificationAuthoritySources);

export const QualificationProductAuthorityInvocation = Schema.Struct({
  executionId: Schema.String,
  manifestChecksum: Schema.String,
  planChecksum: Schema.String,
  requestArtifactChecksum: Schema.String,
  requestArtifactId: Schema.String,
});

const QualificationProductAuthorityMissing = Schema.Struct({
  status: Schema.Literal("MISSING"),
  missingSources: Schema.Array(
    Schema.Struct({
      detail: Schema.String,
      source: QualificationAuthoritySource,
    }),
  ),
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
