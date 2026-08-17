import { env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { PDFDocument } from "pdf-lib";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/unstable/http";

import { AllowancePeriodId, UserId } from "../src/domain";
import { ContentId } from "../src/domain/client-content";
import * as DocumentArtifacts from "../src/integrations/cloudflare/document-artifacts";
import * as DocumentArtifactValidation from "../src/integrations/cloudflare/document-artifact-validation";
import * as DocumentDownload from "../src/integrations/cloudflare/document-download";
import { DocumentIntentDigest } from "../src/services/document-generation";

describe("Generated document download", () => {
  it.effect("serves verified bytes through a short-lived authorized reference", () =>
    Effect.gen(function* () {
      const contentId = ContentId.make("document:toolCall:download-176");
      const userId = UserId.make("user-download-176");
      // oxlint-disable-next-line effecttsgo/async-function -- pdf-lib is a Promise-based boundary.
      const pdf = yield* Effect.promise(async () => {
        const document = await PDFDocument.create();
        document.addPage();
        return document.save({ useObjectStreams: false });
      });
      const artifact = yield* DocumentArtifactValidation.validate(contentId, "pdf", pdf, 1);
      const artifacts = DocumentArtifacts.make(env.ARTIFACTS);
      yield* artifacts.delete(contentId);
      yield* artifacts.put({
        allowancePeriodId: AllowancePeriodId.make("period-download-176"),
        artifact,
        bytes: pdf,
        cost: { _tag: "ProvenNoUse" },
        format: "pdf",
        intentDigest: DocumentIntentDigest.make("7".repeat(64)),
        owner: { _tag: "ToolCall", toolCallId: "download-176" },
        retention: "accounted",
        userId,
      });
      const response = yield* DocumentDownload.serve(
        env.ARTIFACTS,
        Effect.succeed({
          authSessionExpiresAt: new Date("2026-12-31T00:00:00.000Z"),
          authSessionId: "active-session",
          userId,
        }),
      ).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`${env.BETTER_AUTH_BASE_URL}/documents/export?contentId=${contentId}`),
          ),
        ),
      );
      const leaked = yield* DocumentDownload.serve(
        env.ARTIFACTS,
        Effect.succeed({
          authSessionExpiresAt: new Date("2026-12-31T00:00:00.000Z"),
          authSessionId: "other-session",
          userId: UserId.make("other-user"),
        }),
      ).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`${env.BETTER_AUTH_BASE_URL}/documents/export?contentId=${contentId}`),
          ),
        ),
      );

      expect(response.status).toBe(200);
      expect(leaked.status).toBe(404);
      expect(response.headers["content-type"]).toBe("application/pdf");
      expect(response.body).toMatchObject({ _tag: "Uint8Array", body: pdf });
      yield* artifacts.delete(contentId);
    }),
  );
});
