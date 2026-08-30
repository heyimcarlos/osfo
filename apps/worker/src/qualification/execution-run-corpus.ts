import { Schema } from "effect";

import { canonicalQualificationJson, qualificationChecksum } from "./qualification-checksum";
import { qualificationEvaluationLeafJoinPageCount } from "./owner-partitions";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Identity = Schema.String.check(Schema.isMinLength(1));

export const QualificationExecutionRunCorpusReceipt = Schema.Struct({
  acceptedCount: Count,
  artifactId: Identity,
  checksum: Identity,
  completeOutcomeCount: Count,
  completionCount: Count,
  executionId: Identity,
  expectedRootCount: Count,
  failOutcomeCount: Count,
  manifestChecksum: Identity,
  missingCompletionCount: Count,
  outcomeMissingCount: Count,
  pageCount: Count,
  partitionCount: Count,
  planChecksum: Identity,
  rootCount: Count,
  sourceVersion: Identity,
  terminalJoinPageChecksum: Identity,
  terminalLaunchPageChecksum: Identity,
  topologyVersion: Identity,
  version: Schema.Literal("qualification-execution-run-corpus-receipt-v1"),
});

export type QualificationExecutionRunCorpusReceipt =
  typeof QualificationExecutionRunCorpusReceipt.Type;

/** Keeps this canonical compact authority below the ticket's 4 KiB durable-value budget. */
export const qualificationExecutionRunCorpusReceiptMaximumEncodedBytes = 4_095;

export const qualificationExecutionRunCorpusReceiptArtifactId = (executionId: string) =>
  `qualification/executions/${encodeURIComponent(executionId)}/evaluation-leaf-join/completion.json`;

export const qualificationExecutionRunCorpusReceipt = (
  input: Omit<QualificationExecutionRunCorpusReceipt, "artifactId" | "checksum" | "version">,
): QualificationExecutionRunCorpusReceipt => {
  const counts = [
    input.acceptedCount,
    input.completeOutcomeCount,
    input.completionCount,
    input.expectedRootCount,
    input.failOutcomeCount,
    input.missingCompletionCount,
    input.outcomeMissingCount,
    input.pageCount,
    input.partitionCount,
    input.rootCount,
  ];
  if (
    !counts.every((count) => Number.isSafeInteger(count) && count >= 0) ||
    input.partitionCount === 0 ||
    input.pageCount === 0 ||
    input.pageCount !== qualificationEvaluationLeafJoinPageCount(input.partitionCount) ||
    input.completionCount + input.missingCompletionCount !== input.partitionCount ||
    input.completeOutcomeCount + input.failOutcomeCount + input.outcomeMissingCount !==
      input.completionCount ||
    input.missingCompletionCount !== 0 ||
    input.completionCount !== input.partitionCount ||
    input.rootCount !== input.expectedRootCount ||
    input.acceptedCount > input.rootCount
  ) {
    throw new Error("Qualification execution/run corpus receipt conflicts");
  }
  const content = {
    ...input,
    artifactId: qualificationExecutionRunCorpusReceiptArtifactId(input.executionId),
    version: "qualification-execution-run-corpus-receipt-v1" as const,
  };
  const receipt = { ...content, checksum: qualificationChecksum(content) };
  if (
    new TextEncoder().encode(canonicalQualificationJson(receipt)).byteLength >
    qualificationExecutionRunCorpusReceiptMaximumEncodedBytes
  ) {
    throw new Error("Qualification execution/run corpus receipt exceeds its byte budget");
  }
  return receipt;
};
