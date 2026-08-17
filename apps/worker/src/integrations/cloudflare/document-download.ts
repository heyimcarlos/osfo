import type { CurrentUserValue } from "@osfo/api/middleware/auth";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ContentId } from "../../domain/client-content";
import type {
  DocumentDownloadAuthorizationUnavailable,
  DocumentDownloadUnauthorized,
} from "../../middleware/auth";
import * as ArtifactR2 from "./document-artifacts";
/** Serve retained bytes only to the current authenticated owner. */
export const serve = <R>(
  bucket: R2Bucket,
  currentUser: Effect.Effect<
    CurrentUserValue,
    DocumentDownloadAuthorizationUnavailable | DocumentDownloadUnauthorized,
    R
  >,
) =>
  Effect.gen(function* () {
    const user = yield* currentUser;
    return yield* Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const contentId = yield* Schema.decodeUnknownEffect(ContentId)(
        new URL(request.url, "https://worker.invalid").searchParams.get("contentId"),
      ).pipe(Effect.option);
      if (Option.isNone(contentId)) return HttpServerResponse.empty({ status: 404 });
      const artifacts = ArtifactR2.make(bucket);
      const metadata = yield* artifacts.inspect(contentId.value).pipe(Effect.option);
      if (Option.isNone(metadata) || metadata.value === null) {
        return HttpServerResponse.empty({ status: 404 });
      }
      if (metadata.value.userId !== user.userId) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const bytes = yield* artifacts.readBytes(metadata.value).pipe(Effect.option);
      if (Option.isNone(bytes)) return HttpServerResponse.empty({ status: 503 });
      const content = metadata.value.artifact.content;
      return HttpServerResponse.uint8Array(bytes.value, {
        contentType: content.mediaType,
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": `attachment; filename="document.${metadata.value.format}"`,
          "content-length": String(content.byteLength),
          etag: `"sha256-${content.sha256}"`,
          "x-content-sha256": content.sha256,
        },
      });
    });
  }).pipe(
    Effect.catchTags({
      DocumentDownloadAuthorizationUnavailable: () =>
        Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      DocumentDownloadUnauthorized: () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
    }),
    Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))),
  );
