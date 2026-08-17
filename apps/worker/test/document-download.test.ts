import { env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { PDFDocument } from "pdf-lib";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { HttpServerRequest } from "effect/unstable/http";

import { AllowancePeriodId, UserId } from "../src/domain";
import { ContentId } from "../src/domain/client-content";
import * as DocumentArtifact from "../src/domain/document-artifact";
import * as DocumentArtifacts from "../src/integrations/cloudflare/document-artifacts";
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
      const artifact = yield* DocumentArtifact.parse(contentId, "pdf", pdf, 1);
      const artifacts = DocumentArtifacts.make(env.ARTIFACTS);
      const issuedAt = 1_786_968_000_000;
      yield* TestClock.setTime(issuedAt);
      yield* artifacts.delete(contentId);
      yield* artifacts.put({
        allowancePeriodId: AllowancePeriodId.make("period-download-176"),
        artifact,
        bytes: pdf,
        cost: { _tag: "ProvenNoUse" },
        format: "pdf",
        intentDigest: DocumentIntentDigest.make("7".repeat(64)),
        owner: { _tag: "ToolCall", toolCallId: "download-176" },
        userId,
      });
      const downloadUrl = yield* DocumentDownload.makeUrl({
        baseUrl: env.BETTER_AUTH_BASE_URL,
        contentId,
        secret: env.BETTER_AUTH_SECRET,
        userId,
      });

      const response = yield* DocumentDownload.serve(env.ARTIFACTS, env.BETTER_AUTH_SECRET).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(downloadUrl)),
        ),
      );
      const token = new URL(downloadUrl).searchParams.get("token") ?? "";
      const encodedClaim = token.split(".")[0] ?? "";
      const claim = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ expiresAt: Schema.Int, issuedAt: Schema.Int })),
      )(atob(encodedClaim.replaceAll("-", "+").replaceAll("_", "/")));
      yield* TestClock.setTime(4_102_444_800_000);
      const futureUrl = yield* DocumentDownload.makeUrl({
        baseUrl: env.BETTER_AUTH_BASE_URL,
        contentId,
        secret: env.BETTER_AUTH_SECRET,
        userId,
      });
      yield* TestClock.setTime(issuedAt);
      const future = yield* DocumentDownload.serve(env.ARTIFACTS, env.BETTER_AUTH_SECRET).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(futureUrl)),
        ),
      );

      expect(response.status).toBe(200);
      expect(claim.issuedAt).toBe(issuedAt);
      expect(claim.expiresAt - claim.issuedAt).toBe(DocumentDownload.downloadValidityMs);
      expect(future.status).toBe(404);
      expect(response.headers["content-type"]).toBe("application/pdf");
      expect(response.body).toMatchObject({ _tag: "Uint8Array", body: pdf });
      yield* artifacts.delete(contentId);
    }),
  );
});
