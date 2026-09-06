/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned to it.effect. */
import { afterEach, expect, it, vi } from "@effect/vitest";
import { documentDownloadUrl, documentExportUrl } from "@osfo/api/document-download";
import { DateTime, Effect, Schema } from "effect";
import { HttpServerRequest } from "effect/unstable/http";

import { AllowancePeriodId, UserId } from "../../domain";
import { DocumentArtifact } from "../../domain/document-artifact";
import { DocumentDownloadUnauthorized } from "../../middleware/auth";
import { DocumentIntentDigest, type ArtifactStore } from "../../services/document-generation";
import { DocumentArtifacts } from "./document-artifacts";
import { DocumentDownload } from "./document-download";

const artifact = Schema.decodeSync(DocumentArtifact.ArtifactRef)({
  artifactRole: { _tag: "GeneratedDocumentV1", format: "pdf", pageCount: 1 },
  content: {
    contentId: "document:toolCall:ordinary-form",
    mediaType: "application/pdf",
    byteLength: 4,
    sha256: "a".repeat(64),
  },
  lineage: { sourceContentId: null },
});

afterEach(() => vi.restoreAllMocks());

it.effect("keeps a returned download link opaque and serves bytes only to the retained owner", () =>
  Effect.gen(function* () {
    const readBytes = vi.fn<ArtifactStore["readBytes"]>(() =>
      Effect.succeed(new Uint8Array([1, 2, 3, 4])),
    );
    const inspect = vi.fn<ArtifactStore["inspect"]>(() =>
      Effect.succeed({
        allowancePeriodId: AllowancePeriodId.make("period-one"),
        artifact,
        cost: { _tag: "ProvenNoUse" as const },
        format: "pdf" as const,
        intentDigest: DocumentIntentDigest.make("b".repeat(64)),
        owner: { _tag: "ToolCall" as const, toolCallId: "ordinary-form" },
        retention: "accounted" as const,
        userId: UserId.make("owner-one"),
      }),
    );
    vi.spyOn(DocumentArtifacts, "make").mockReturnValue({
      account: () => Effect.die(new Error("Download cannot change accounting")),
      delete: () => Effect.die(new Error("Download cannot delete the artifact")),
      inspect,
      put: () => Effect.die(new Error("Download cannot replace the artifact")),
      readBytes,
    });
    const pageUrl = documentDownloadUrl(artifact.content.contentId, "https://osfo.test");
    const requestedContentId = new URL(pageUrl).searchParams.get("contentId");
    expect(requestedContentId).toBe(artifact.content.contentId);
    const request = HttpServerRequest.fromWeb(
      new Request(documentExportUrl(artifact.content.contentId, "https://api.osfo.test")),
    );
    // SAFETY: The injected ArtifactStore owns all reads; this bucket is never accessed.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test exercises HTTP ownership, with the R2 boundary supplied above.
    const bucket = {} as R2Bucket;
    const serve = (userId: string | undefined) =>
      DocumentDownload.serve(
        bucket,
        userId === undefined
          ? Effect.fail(new DocumentDownloadUnauthorized({}))
          : Effect.succeed({
              authSessionExpiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-07T00:00:00Z")),
              authSessionId: "download-session",
              userId,
            }),
        "document",
      ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request));

    expect((yield* serve(undefined)).status).toBe(401);
    expect(inspect).not.toHaveBeenCalled();
    expect((yield* serve("another-owner")).status).toBe(404);
    expect(readBytes).not.toHaveBeenCalled();
    const owned = yield* serve("owner-one");
    expect(owned.status).toBe(200);
    expect(owned.headers["content-disposition"]).toBe('attachment; filename="document.pdf"');
    expect(owned.headers["cache-control"]).toBe("private, no-store");
    expect(readBytes).toHaveBeenCalledTimes(1);
  }),
);
