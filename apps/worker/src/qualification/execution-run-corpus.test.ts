import { describe, expect, it } from "@effect/vitest";

import { canonicalQualificationJson } from "./qualification-checksum";
import {
  QualificationExecutionRunCorpusReceipt,
  qualificationExecutionRunCorpusReceipt,
  qualificationExecutionRunCorpusReceiptMaximumEncodedBytes,
} from "./execution-run-corpus";

const input = {
  acceptedCount: 12,
  completeOutcomeCount: 2,
  completionCount: 2,
  executionId: "execution-corpus-test",
  expectedRootCount: 12,
  failOutcomeCount: 0,
  manifestChecksum: "manifest-checksum",
  missingCompletionCount: 0,
  outcomeMissingCount: 0,
  pageCount: 1,
  partitionCount: 2,
  planChecksum: "plan-checksum",
  rootCount: 12,
  sourceVersion: "source-v1",
  terminalJoinPageChecksum: "join-checksum",
  terminalLaunchPageChecksum: "launch-checksum",
  topologyVersion: "topology-v1",
};

describe("qualification execution/run corpus receipt", () => {
  it("seals exact terminal corpus algebra in a bounded content-free receipt", () => {
    const receipt = qualificationExecutionRunCorpusReceipt(input);
    expect(new TextEncoder().encode(canonicalQualificationJson(receipt)).byteLength).toBeLessThan(
      4_096,
    );
    expect(Object.keys(QualificationExecutionRunCorpusReceipt.fields)).toEqual([
      "acceptedCount",
      "artifactId",
      "checksum",
      "completeOutcomeCount",
      "completionCount",
      "executionId",
      "expectedRootCount",
      "failOutcomeCount",
      "manifestChecksum",
      "missingCompletionCount",
      "outcomeMissingCount",
      "pageCount",
      "partitionCount",
      "planChecksum",
      "rootCount",
      "sourceVersion",
      "terminalJoinPageChecksum",
      "terminalLaunchPageChecksum",
      "topologyVersion",
      "version",
    ]);
  });

  it.each([
    ["missing completion", { missingCompletionCount: 1 }],
    ["partition mismatch", { completionCount: 1 }],
    ["outcome mismatch", { completeOutcomeCount: 1 }],
    ["root mismatch", { rootCount: 11 }],
    ["accepted overflow", { acceptedCount: 13 }],
    ["unsafe count", { rootCount: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects %s", (_, override) => {
    expect(() => qualificationExecutionRunCorpusReceipt({ ...input, ...override })).toThrow(
      "Qualification execution/run corpus receipt conflicts",
    );
  });

  it("rejects an encoded receipt at or above the four KiB boundary", () => {
    expect(qualificationExecutionRunCorpusReceiptMaximumEncodedBytes).toBe(4_095);
    expect(() =>
      qualificationExecutionRunCorpusReceipt({
        ...input,
        executionId: "x".repeat(qualificationExecutionRunCorpusReceiptMaximumEncodedBytes),
      }),
    ).toThrow("exceeds its byte budget");
  });

  it.each([
    [50, 1],
    [51, 2],
    [6_894, 138],
  ])("binds %i partitions to exactly %i leaf join pages", (partitionCount, pageCount) => {
    expect(
      qualificationExecutionRunCorpusReceipt({
        ...input,
        completeOutcomeCount: partitionCount,
        completionCount: partitionCount,
        pageCount,
        partitionCount,
      }).pageCount,
    ).toBe(pageCount);
    expect(() =>
      qualificationExecutionRunCorpusReceipt({
        ...input,
        completeOutcomeCount: partitionCount,
        completionCount: partitionCount,
        pageCount: pageCount + 1,
        partitionCount,
      }),
    ).toThrow("Qualification execution/run corpus receipt conflicts");
  });
});
