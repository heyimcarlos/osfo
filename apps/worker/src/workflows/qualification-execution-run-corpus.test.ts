/* oxlint-disable effecttsgo/async-function -- Promise fakes model the R2 boundary. */
import { describe, expect, it } from "@effect/vitest";

import { canonicalQualificationJson } from "../qualification/qualification-checksum";
import { qualificationExecutionRunCorpusReceiptArtifactId } from "../qualification/execution-run-corpus";
import {
  QualificationExecutionRunCorpusRetentionConflict,
  authenticateQualificationExecutionRunCorpusReceipt,
  retainQualificationExecutionRunCorpusReceipt,
} from "./qualification-execution-run-corpus";

const authority = {
  completion: {
    acceptedCount: 12,
    completeOutcomeCount: 2,
    completionCount: 2,
    failOutcomeCount: 0,
    missingCompletionCount: 0,
    outcomeMissingCount: 0,
    pageCount: 1,
    rootCount: 12,
    terminalPageChecksum: "join-checksum",
  },
  descriptor: { partitionCount: 2, terminalPageChecksum: "launch-checksum" },
  executionId: "execution-corpus-storage-test",
  expectedRootCount: 12,
  manifestChecksum: "manifest-checksum",
  planChecksum: "plan-checksum",
  sourceVersion: "source-v1",
  topologyVersion: "topology-v1",
};

const memoryBucket = () => {
  const values = new Map<
    string,
    {
      customMetadata: Readonly<Record<string, string>>;
      encoded: string;
      httpMetadata: { readonly contentType?: string };
    }
  >();
  let getCount = 0;
  let loseNextPutResponse = false;
  const bucket = {
    get: (key: string) => {
      getCount += 1;
      const value = values.get(key);
      return Promise.resolve(
        value === undefined
          ? null
          : {
              customMetadata: value.customMetadata,
              httpMetadata: value.httpMetadata,
              text: () => Promise.resolve(value.encoded),
            },
      );
    },
    put: (key: string, encoded: string, options: R2PutOptions) => {
      if (values.has(key)) return Promise.resolve(null);
      const contentType =
        options.httpMetadata instanceof Headers
          ? (options.httpMetadata.get("content-type") ?? undefined)
          : options.httpMetadata?.contentType;
      values.set(key, {
        customMetadata: options.customMetadata ?? {},
        encoded,
        httpMetadata: contentType === undefined ? {} : { contentType },
      });
      if (loseNextPutResponse) {
        loseNextPutResponse = false;
        return Promise.reject(new Error("lost response"));
      }
      return Promise.resolve({ etag: "created" });
    },
  };
  return {
    bucket,
    getCount: () => getCount,
    loseNextPutResponse: () => {
      loseNextPutResponse = true;
    },
    values,
  };
};

const authenticate = (
  bucket: ReturnType<typeof memoryBucket>["bucket"],
  checksum: string,
  artifactId = qualificationExecutionRunCorpusReceiptArtifactId(authority.executionId),
) =>
  authenticateQualificationExecutionRunCorpusReceipt({
    artifactId,
    bucket,
    checksum,
    executionId: authority.executionId,
    expectedRootCount: authority.expectedRootCount,
    manifestChecksum: authority.manifestChecksum,
    partitionCount: authority.descriptor.partitionCount,
    planChecksum: authority.planChecksum,
    sourceVersion: authority.sourceVersion,
    topologyVersion: authority.topologyVersion,
  });

describe("qualification execution/run corpus R2 authority", () => {
  it("creates, authenticates, and exactly replays the immutable receipt", async () => {
    const storage = memoryBucket();
    const receipt = await retainQualificationExecutionRunCorpusReceipt({
      ...authority,
      bucket: storage.bucket,
    });
    await expect(authenticate(storage.bucket, receipt.checksum)).resolves.toEqual({
      receipt,
      status: "COMPLETE",
    });
    await expect(
      retainQualificationExecutionRunCorpusReceipt({ ...authority, bucket: storage.bucket }),
    ).resolves.toEqual(receipt);
  });

  it("reconciles a lost create response on exact replay", async () => {
    const storage = memoryBucket();
    storage.loseNextPutResponse();
    await expect(
      retainQualificationExecutionRunCorpusReceipt({ ...authority, bucket: storage.bucket }),
    ).rejects.toThrow("lost response");
    await expect(
      retainQualificationExecutionRunCorpusReceipt({ ...authority, bucket: storage.bucket }),
    ).resolves.toMatchObject({ executionId: authority.executionId });
  });

  it("rejects a noncanonical artifact id before reading R2", async () => {
    const storage = memoryBucket();
    await expect(authenticate(storage.bucket, "checksum", "substitute.json")).resolves.toEqual({
      status: "FAIL",
    });
    expect(storage.getCount()).toBe(0);
  });

  it("distinguishes missing authority from retained body, checksum, and metadata conflicts", async () => {
    const storage = memoryBucket();
    await expect(authenticate(storage.bucket, "checksum")).resolves.toEqual({ status: "MISSING" });
    const receipt = await retainQualificationExecutionRunCorpusReceipt({
      ...authority,
      bucket: storage.bucket,
    });
    const retained = storage.values.get(receipt.artifactId);
    if (retained === undefined) throw new Error("fixture receipt missing");
    storage.values.set(receipt.artifactId, {
      ...retained,
      encoded: canonicalQualificationJson({ ...receipt, checksum: "forged-self-checksum" }),
    });
    await expect(authenticate(storage.bucket, "forged-self-checksum")).resolves.toEqual({
      status: "FAIL",
    });
    storage.values.set(receipt.artifactId, {
      ...retained,
      httpMetadata: { contentType: "text/plain" },
    });
    await expect(authenticate(storage.bucket, receipt.checksum)).resolves.toEqual({
      status: "FAIL",
    });
    storage.values.set(receipt.artifactId, {
      ...retained,
      customMetadata: {
        ...retained.customMetadata,
        "osfo-terminal-join-page-checksum": "tampered",
      },
    });
    await expect(authenticate(storage.bucket, receipt.checksum)).resolves.toEqual({
      status: "FAIL",
    });
  });

  it("surfaces different retained bytes as a structural collision", async () => {
    const storage = memoryBucket();
    const receipt = await retainQualificationExecutionRunCorpusReceipt({
      ...authority,
      bucket: storage.bucket,
    });
    const retained = storage.values.get(receipt.artifactId);
    if (retained === undefined) throw new Error("fixture receipt missing");
    storage.values.set(receipt.artifactId, { ...retained, encoded: `${retained.encoded} ` });
    await expect(
      retainQualificationExecutionRunCorpusReceipt({ ...authority, bucket: storage.bucket }),
    ).rejects.toBeInstanceOf(QualificationExecutionRunCorpusRetentionConflict);
  });
});
