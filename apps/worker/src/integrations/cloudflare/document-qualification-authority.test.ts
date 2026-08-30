/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect tests. */
/* oxlint-disable effecttsgo/global-date -- Fixed producer timestamps make receipts deterministic. */
import { expect, it } from "@effect/vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { Effect, Result, Schema } from "effect";

import { ContentId } from "../../domain/client-content";
import type { QualificationContext } from "../../domain/qualification-context";
import { FileDigest } from "../../domain/file-content";
import { FileId } from "../../domain/file";
import { DocumentBuild } from "../../services/document-build";
import {
  DocumentQualificationAuthority,
  QualificationDocumentAuthorityUnavailable,
} from "./document-qualification-authority";
import { contentKeyFor, qualificationReceiptKeyFor } from "./document-storage-keys";

const workflowId = DocumentBuild.WorkflowId.make("document-build:qualification-sidecar");
const contentId = ContentId.make(`document:workflow:${workflowId}`);
const build = {
  artifactAccountedAt: new Date("2026-08-30T12:00:03.000Z"),
  artifactContentId: contentId,
  qualificationContext: {
    attemptId: "attempt-sidecar",
    executionId: "execution-sidecar",
    journey: "documentBuild",
    offeredAtEpochMs: 1_788_000_000_000,
    planChecksum: "plan-sidecar",
    region: "americas",
    rootId: "root-sidecar",
    runId: "run-sidecar",
  },
  request: DocumentBuild.StoredRequest.make({
    fileSnapshots: [
      {
        byteLength: 1n,
        fileId: FileId.make("qualification-sidecar-file"),
        mediaType: "text/plain",
        sha256: FileDigest.make(`sha256:${"c".repeat(64)}`),
      },
    ],
    format: "pdf",
    source: { pages: [{ lines: ["qualification"], title: "Qualification" }] },
  }),
  state: "publication_committed",
  workflowId,
} satisfies Pick<
  DocumentBuild.Record,
  | "artifactAccountedAt"
  | "artifactContentId"
  | "qualificationContext"
  | "request"
  | "state"
  | "workflowId"
>;

it.effect("retains and exactly replays one immutable index over the actual R2 object", () =>
  Effect.gen(function* () {
    const fixture = bucketFixture();
    yield* DocumentQualificationAuthority.retain(fixture.bucket, build, contentId);
    yield* DocumentQualificationAuthority.retain(fixture.bucket, build, contentId);

    const encoded = fixture.body(
      qualificationReceiptKeyFor(
        build.qualificationContext.executionId,
        build.qualificationContext.runId,
        contentId,
      ),
    );
    expect(encoded).toBeDefined();
    if (encoded === undefined) return;
    const receipt = yield* Schema.decodeEffect(
      Schema.fromJsonString(DocumentQualificationAuthority.QualificationDocumentObjectReceipt),
    )(encoded);
    expect(receipt).toMatchObject({
      executionId: build.qualificationContext.executionId,
      objectId: contentId,
      rootId: build.qualificationContext.rootId,
      workflowId: build.workflowId,
    });
  }),
);

it.effect("fails closed when the actual object owns another root", () => {
  const fixture = bucketFixture({ rootId: "another-root" });
  return DocumentQualificationAuthority.retain(fixture.bucket, build, contentId).pipe(
    Effect.result,
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(QualificationDocumentAuthorityUnavailable);
        }
      }),
    ),
  );
});

for (const [name, fixtureOptions] of [
  ["pending encoded retention", { retention: "pending" }],
  ["wrong encoded media type", { mediaType: "application/octet-stream" }],
  ["wrong encoded owner", { workflowId: "document-build:other" }],
  ["wrong encoded offered time", { context: { offeredAtEpochMs: 1_788_000_000_001 } }],
  ["wrong encoded region", { context: { region: "europe" } }],
  ["wrong encoded journey", { context: { journey: "fileAnalysis" } }],
] as const) {
  it.effect(`fails closed for ${name}`, () => {
    const fixture = bucketFixture(fixtureOptions);
    return DocumentQualificationAuthority.retain(fixture.bucket, build, contentId).pipe(
      Effect.result,
      Effect.tap((result) => Effect.sync(() => expect(Result.isFailure(result)).toBe(true))),
    );
  });
}

const bucketFixture = (
  overrides: {
    readonly context?: Partial<QualificationContext>;
    readonly mediaType?: string;
    readonly retention?: "accounted" | "pending";
    readonly rootId?: string;
    readonly workflowId?: string;
  } = {},
) => {
  const bodies = new Map<string, string>();
  const metadata = new Map<string, Record<string, string>>();
  const digest = "a".repeat(64);
  const object = {
    checksums: { sha256: hexToBytes(digest).buffer, toJSON: () => ({ sha256: digest }) },
    customMetadata: {
      "osfo-sha256": digest,
      osfo: JSON.stringify({
        allowancePeriodId: "period-sidecar",
        artifact: {
          artifactRole: { _tag: "GeneratedDocumentV1", format: "pdf", pageCount: 1 },
          content: {
            byteLength: 3,
            contentId,
            mediaType: overrides.mediaType ?? "application/pdf",
            sha256: digest,
          },
          lineage: { sourceContentId: null },
        },
        cost: { _tag: "ProvenNoUse" },
        format: "pdf",
        intentDigest: "b".repeat(64),
        owner: { _tag: "Workflow", workflowId: overrides.workflowId ?? build.workflowId },
        qualificationContext: { ...build.qualificationContext, ...overrides.context },
        retention: overrides.retention ?? "accounted",
        userId: "qualification-sidecar-user",
      }),
      osfoAttemptId: build.qualificationContext.attemptId,
      osfoExecutionId: build.qualificationContext.executionId,
      osfoObjectId: contentId,
      osfoPlanChecksum: build.qualificationContext.planChecksum,
      osfoRootId: overrides.rootId ?? build.qualificationContext.rootId,
      osfoRunId: build.qualificationContext.runId,
    },
    etag: "etag-sidecar",
    httpEtag: '"etag-sidecar"',
    key: contentKeyFor(contentId),
    size: 3,
    storageClass: "Standard",
    uploaded: new Date("2026-08-30T12:00:02.000Z"),
    version: "version-sidecar",
    writeHttpMetadata: () => undefined,
  };
  const bucket = {
    get: (key: string) => {
      const body = bodies.get(key);
      return Promise.resolve(
        body === undefined
          ? null
          : {
              ...object,
              customMetadata: metadata.get(key),
              text: () => Promise.resolve(body),
            },
      );
    },
    head: (key: string) => Promise.resolve(key === contentKeyFor(contentId) ? object : null),
    put: (key: string, body: string, options: R2PutOptions) => {
      if (bodies.has(key)) return Promise.resolve(null);
      bodies.set(key, body);
      metadata.set(key, options.customMetadata ?? {});
      return Promise.resolve(object);
    },
  };
  return {
    body: (key: string) => bodies.get(key),
    // SAFETY: This test double implements the exact head/get/put methods used by the authority index.
    // oxlint-disable-next-line osfo/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Narrow R2 fake.
    bucket: bucket as unknown as R2Bucket,
  };
};
