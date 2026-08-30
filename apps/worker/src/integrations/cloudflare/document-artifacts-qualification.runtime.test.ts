/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect tests. */
import { expect, it } from "@effect/vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { env } from "cloudflare:workers";
import { Effect } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import { ContentId } from "../../domain/client-content";
import { DocumentArtifact } from "../../domain/document-artifact";
import { DocumentIntentDigest, type StoredArtifact } from "../../services/document-generation";
import { DocumentArtifacts } from "./document-artifacts";
import { contentKeyFor } from "./document-storage-keys";

it.effect("round-trips qualification identity and real SHA-256 through R2 accounting", () =>
  Effect.gen(function* () {
    const artifacts = DocumentArtifacts.make(env.ARTIFACTS);
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = bytesToHex(sha256(bytes));
    const contentId = ContentId.make("document:workflow:qualification-r2-runtime");
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
        workflowId: "document-build:qualification-r2-runtime",
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
    yield* artifacts.delete(stored);
  }),
);
