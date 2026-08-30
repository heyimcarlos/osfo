/* oxlint-disable effecttsgo/async-function -- R2 and Web Crypto are Promise-native Worker boundaries. */
import { Data, Schema } from "effect";

import {
  QualificationExecutionRunCorpusReceipt,
  qualificationExecutionRunCorpusReceipt,
  qualificationExecutionRunCorpusReceiptArtifactId,
  qualificationExecutionRunCorpusReceiptMaximumEncodedBytes,
} from "../qualification/execution-run-corpus";
import { canonicalQualificationJson } from "../qualification/qualification-checksum";

interface CorpusBucket {
  readonly get: (key: string) => Promise<{
    readonly customMetadata?: Readonly<Record<string, string>>;
    readonly httpMetadata?: { readonly contentType?: string };
    readonly text: () => Promise<string>;
  } | null>;
  readonly put: (
    key: string,
    value: string,
    options: {
      readonly customMetadata: Readonly<Record<string, string>>;
      readonly httpMetadata: { readonly contentType: "application/json" };
      readonly onlyIf: { readonly etagDoesNotMatch: "*" };
    },
  ) => Promise<{ readonly etag: string } | null>;
}

const sha256Hex = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const metadataFor = (receipt: QualificationExecutionRunCorpusReceipt, bodySha256: string) => ({
  "osfo-artifact-checksum": receipt.checksum,
  "osfo-body-sha256": bodySha256,
  "osfo-completion-count": String(receipt.completionCount),
  "osfo-execution-id": receipt.executionId,
  "osfo-expected-root-count": String(receipt.expectedRootCount),
  "osfo-kind": receipt.version,
  "osfo-manifest-checksum": receipt.manifestChecksum,
  "osfo-page-count": String(receipt.pageCount),
  "osfo-partition-count": String(receipt.partitionCount),
  "osfo-plan-checksum": receipt.planChecksum,
  "osfo-root-count": String(receipt.rootCount),
  "osfo-source-version": receipt.sourceVersion,
  "osfo-terminal-join-page-checksum": receipt.terminalJoinPageChecksum,
  "osfo-terminal-launch-page-checksum": receipt.terminalLaunchPageChecksum,
  "osfo-topology-version": receipt.topologyVersion,
});

const exactMetadata = (
  actual: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>>,
) =>
  actual !== undefined &&
  Object.keys(actual).length === Object.keys(expected).length &&
  Object.entries(expected).every(([key, value]) => actual[key] === value);

export class QualificationExecutionRunCorpusRetentionConflict extends Data.TaggedError(
  "QualificationExecutionRunCorpusRetentionConflict",
)<{ readonly artifactId: string; readonly message: string }> {}

export const retainQualificationExecutionRunCorpusReceipt = async (input: {
  readonly bucket: CorpusBucket;
  readonly completion: {
    readonly acceptedCount: number;
    readonly completeOutcomeCount: number;
    readonly completionCount: number;
    readonly failOutcomeCount: number;
    readonly missingCompletionCount: number;
    readonly outcomeMissingCount: number;
    readonly pageCount: number;
    readonly rootCount: number;
    readonly terminalPageChecksum: string;
  };
  readonly descriptor: { readonly partitionCount: number; readonly terminalPageChecksum: string };
  readonly executionId: string;
  readonly expectedRootCount: number;
  readonly manifestChecksum: string;
  readonly planChecksum: string;
  readonly sourceVersion: string;
  readonly topologyVersion: string;
}) => {
  const receipt = qualificationExecutionRunCorpusReceipt({
    acceptedCount: input.completion.acceptedCount,
    completeOutcomeCount: input.completion.completeOutcomeCount,
    completionCount: input.completion.completionCount,
    executionId: input.executionId,
    expectedRootCount: input.expectedRootCount,
    failOutcomeCount: input.completion.failOutcomeCount,
    manifestChecksum: input.manifestChecksum,
    missingCompletionCount: input.completion.missingCompletionCount,
    outcomeMissingCount: input.completion.outcomeMissingCount,
    pageCount: input.completion.pageCount,
    partitionCount: input.descriptor.partitionCount,
    planChecksum: input.planChecksum,
    rootCount: input.completion.rootCount,
    sourceVersion: input.sourceVersion,
    terminalJoinPageChecksum: input.completion.terminalPageChecksum,
    terminalLaunchPageChecksum: input.descriptor.terminalPageChecksum,
    topologyVersion: input.topologyVersion,
  });
  const encoded = canonicalQualificationJson(receipt);
  const metadata = metadataFor(receipt, await sha256Hex(encoded));
  const retained = await input.bucket.put(receipt.artifactId, encoded, {
    customMetadata: metadata,
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (retained !== null) return receipt;
  const existing = await input.bucket.get(receipt.artifactId);
  if (
    existing === null ||
    (await existing.text()) !== encoded ||
    existing.httpMetadata?.contentType !== "application/json" ||
    !exactMetadata(existing.customMetadata, metadata)
  ) {
    throw new QualificationExecutionRunCorpusRetentionConflict({
      artifactId: receipt.artifactId,
      message: "Retained qualification execution/run corpus receipt conflicts",
    });
  }
  return receipt;
};

export const authenticateQualificationExecutionRunCorpusReceipt = async (input: {
  readonly artifactId: string;
  readonly bucket: Pick<CorpusBucket, "get">;
  readonly checksum: string;
  readonly executionId: string;
  readonly expectedRootCount: number;
  readonly manifestChecksum: string;
  readonly partitionCount: number;
  readonly planChecksum: string;
  readonly sourceVersion: string;
  readonly topologyVersion: string;
}): Promise<
  | { readonly receipt: QualificationExecutionRunCorpusReceipt; readonly status: "COMPLETE" }
  | { readonly status: "FAIL" | "MISSING" }
> => {
  if (input.artifactId !== qualificationExecutionRunCorpusReceiptArtifactId(input.executionId)) {
    return { status: "FAIL" };
  }
  const retained = await input.bucket.get(input.artifactId);
  if (retained === null) return { status: "MISSING" };
  const encoded = await retained.text();
  if (
    new TextEncoder().encode(encoded).byteLength >
    qualificationExecutionRunCorpusReceiptMaximumEncodedBytes
  ) {
    return { status: "FAIL" };
  }
  let receipt: QualificationExecutionRunCorpusReceipt;
  let reconstructed: QualificationExecutionRunCorpusReceipt;
  try {
    receipt = Schema.decodeSync(Schema.fromJsonString(QualificationExecutionRunCorpusReceipt))(
      encoded,
    );
    reconstructed = qualificationExecutionRunCorpusReceipt({
      acceptedCount: receipt.acceptedCount,
      completeOutcomeCount: receipt.completeOutcomeCount,
      completionCount: receipt.completionCount,
      executionId: receipt.executionId,
      expectedRootCount: receipt.expectedRootCount,
      failOutcomeCount: receipt.failOutcomeCount,
      manifestChecksum: receipt.manifestChecksum,
      missingCompletionCount: receipt.missingCompletionCount,
      outcomeMissingCount: receipt.outcomeMissingCount,
      pageCount: receipt.pageCount,
      partitionCount: receipt.partitionCount,
      planChecksum: receipt.planChecksum,
      rootCount: receipt.rootCount,
      sourceVersion: receipt.sourceVersion,
      terminalJoinPageChecksum: receipt.terminalJoinPageChecksum,
      terminalLaunchPageChecksum: receipt.terminalLaunchPageChecksum,
      topologyVersion: receipt.topologyVersion,
    });
  } catch {
    return { status: "FAIL" };
  }
  const metadata = metadataFor(receipt, await sha256Hex(encoded));
  const authentic =
    receipt.artifactId === input.artifactId &&
    receipt.checksum === input.checksum &&
    receipt.executionId === input.executionId &&
    receipt.expectedRootCount === input.expectedRootCount &&
    receipt.manifestChecksum === input.manifestChecksum &&
    receipt.partitionCount === input.partitionCount &&
    receipt.planChecksum === input.planChecksum &&
    receipt.sourceVersion === input.sourceVersion &&
    receipt.topologyVersion === input.topologyVersion &&
    receipt.checksum === reconstructed.checksum &&
    encoded === canonicalQualificationJson(reconstructed) &&
    retained.httpMetadata?.contentType === "application/json" &&
    exactMetadata(retained.customMetadata, metadata);
  return authentic ? { receipt, status: "COMPLETE" } : { status: "FAIL" };
};
