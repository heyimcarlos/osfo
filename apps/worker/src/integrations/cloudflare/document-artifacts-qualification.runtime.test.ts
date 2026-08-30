/* oxlint-disable vitest/no-standalone-expect, effecttsgo/global-date, effecttsgo/global-date-in-effect -- Assertions execute inside Effect tests with fixed authority timestamps. */
import { expect, it } from "@effect/vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { env } from "cloudflare:workers";
import { Effect } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import { ContentId } from "../../domain/client-content";
import { DocumentArtifact } from "../../domain/document-artifact";
import { FileDigest } from "../../domain/file-content";
import { FileId } from "../../domain/file";
import { DocumentBuild } from "../../services/document-build";
import { DocumentIntentDigest, type StoredArtifact } from "../../services/document-generation";
import { DocumentArtifacts } from "./document-artifacts";
import { DocumentQualificationAuthority } from "./document-qualification-authority";
import { contentKeyFor, qualificationReceiptKeyFor } from "./document-storage-keys";
import { qualificationDocumentR2AuthorityRecords } from "../../qualification-product-authority-worker";

it.effect("round-trips qualification identity and real SHA-256 through R2 accounting", () =>
  Effect.gen(function* () {
    const artifacts = DocumentArtifacts.make(env.ARTIFACTS);
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = bytesToHex(sha256(bytes));
    const workflowId = DocumentBuild.WorkflowId.make("document-build:qualification-r2-runtime");
    const contentId = ContentId.make(`document:workflow:${workflowId}`);
    const artifact = yield* DocumentArtifact.make(contentId, "pdf", bytes.length, 1, digest);
    const stored = {
      allowancePeriodId: AllowancePeriodId.make("qualification-r2-runtime-period"),
      artifact,
      bytes,
      cost: { _tag: "ProvenNoUse" },
      format: "pdf",
      intentDigest: DocumentIntentDigest.make("b".repeat(64)),
      owner: DocumentArtifact.DocumentOwner.make({
        _tag: "Workflow",
        workflowId,
      }),
      qualificationContext: {
        attemptId: "qualification-r2-runtime-attempt",
        executionId: "qualification-r2-runtime-execution",
        journey: "documentBuild",
        offeredAtEpochMs: 1_788_000_000_000,
        planChecksum: "qualification-r2-runtime-plan",
        region: "americas",
        rootId: "qualification-r2-runtime-root",
        runId: "qualification-r2-runtime-run",
      },
      retention: "pending",
      userId: UserId.make("qualification-r2-runtime-user"),
    } satisfies StoredArtifact;
    yield* artifacts.delete(stored);
    yield* artifacts.put(stored);
    yield* artifacts.account(contentId);
    const build = {
      artifactAccountedAt: new Date("2026-08-30T12:00:03.000Z"),
      artifactContentId: contentId,
      qualificationContext: stored.qualificationContext,
      request: DocumentBuild.StoredRequest.make({
        fileSnapshots: [
          {
            byteLength: 1n,
            fileId: FileId.make("qualification-r2-runtime-file"),
            mediaType: "text/plain",
            sha256: FileDigest.make(`sha256:${"c".repeat(64)}`),
          },
        ],
        format: "pdf",
        source: { pages: [{ lines: ["qualification"], title: "Qualification" }] },
      }),
      state: "success" as const,
      workflowId,
    };
    yield* DocumentQualificationAuthority.retain(env.ARTIFACTS, build, contentId);

    const object = yield* Effect.promise(() => env.ARTIFACTS.head(contentKeyFor(contentId)));
    expect(object?.customMetadata).toMatchObject({
      "osfo-sha256": digest,
      osfoObjectId: contentId,
      osfoRootId: stored.qualificationContext.rootId,
    });
    expect(
      object?.checksums.sha256 === undefined
        ? undefined
        : bytesToHex(new Uint8Array(object.checksums.sha256)),
    ).toBe(digest);
    expect((yield* artifacts.inspect(contentId))?.qualificationContext).toEqual(
      stored.qualificationContext,
    );
    expect(
      yield* Effect.promise(() =>
        env.ARTIFACTS.head(
          qualificationReceiptKeyFor(
            stored.qualificationContext.executionId,
            stored.qualificationContext.runId,
            contentId,
          ),
        ),
      ),
    ).toBeDefined();
    expect(
      yield* Effect.promise(() => qualificationDocumentR2AuthorityRecords(env.ARTIFACTS, [build])),
    ).toMatchObject({
      _tag: "Ready",
      records: [{ objectId: contentId, rootId: stored.qualificationContext.rootId }],
    });
    expect(
      yield* Effect.promise(() =>
        qualificationDocumentR2AuthorityRecords(env.ARTIFACTS, [
          {
            ...build,
            artifactAccountedAt: null,
            artifactContentId: null,
            state: "failure",
            workflowId: DocumentBuild.WorkflowId.make("document-build:terminal-without-object"),
          },
        ]),
      ),
    ).toEqual({ _tag: "Ready", records: [] });
    expect(
      yield* Effect.promise(() =>
        qualificationDocumentR2AuthorityRecords(env.ARTIFACTS, [{ ...build, state: "failure" }]),
      ),
    ).toEqual({ _tag: "Conflict" });
    yield* Effect.promise(() =>
      env.ARTIFACTS.delete(
        qualificationReceiptKeyFor(
          stored.qualificationContext.executionId,
          stored.qualificationContext.runId,
          contentId,
        ),
      ),
    );
    expect(
      yield* Effect.promise(() => qualificationDocumentR2AuthorityRecords(env.ARTIFACTS, [build])),
    ).toEqual({
      _tag: "Missing",
      rootId: stored.qualificationContext.rootId,
    });
    yield* DocumentQualificationAuthority.retain(env.ARTIFACTS, build, contentId);
    const originalObject = yield* Effect.promise(() => env.ARTIFACTS.get(contentKeyFor(contentId)));
    if (originalObject === null) return;
    const originalBytes = yield* Effect.promise(() => originalObject.arrayBuffer());
    const originalMetadata = originalObject.customMetadata;
    const encodedMetadata = originalMetadata?.osfo;
    if (encodedMetadata === undefined) return;
    const originalSha256 = originalObject.checksums.sha256;
    if (originalSha256 === undefined) return;
    const tamperedMetadata = encodedMetadata.replace(
      stored.qualificationContext.rootId,
      "substituted-root",
    );
    yield* Effect.promise(() =>
      env.ARTIFACTS.put(contentKeyFor(contentId), originalBytes, {
        customMetadata: { ...originalMetadata, osfo: tamperedMetadata },
        httpMetadata: { contentType: "application/pdf" },
        sha256: originalSha256,
      }),
    );
    expect(
      yield* Effect.promise(() => qualificationDocumentR2AuthorityRecords(env.ARTIFACTS, [build])),
    ).toEqual({
      _tag: "Conflict",
    });
    expect(
      yield* Effect.promise(() =>
        qualificationDocumentR2AuthorityRecords(env.ARTIFACTS, [
          { ...build, artifactAccountedAt: null, artifactContentId: null, state: "running" },
        ]),
      ),
    ).toEqual({ _tag: "Pending" });
    yield* artifacts.delete(stored);
    expect(
      yield* Effect.promise(() =>
        env.ARTIFACTS.head(
          qualificationReceiptKeyFor(
            stored.qualificationContext.executionId,
            stored.qualificationContext.runId,
            contentId,
          ),
        ),
      ),
    ).toBeNull();
  }),
);
