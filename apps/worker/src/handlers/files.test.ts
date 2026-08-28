/* oxlint-disable effecttsgo/global-date, eslint/no-underscore-dangle, vitest/no-standalone-expect -- Fixed middleware timestamps and Effect test callbacks make ingress evidence deterministic. */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { BrowserFileId, FileUploadQuery } from "@osfo/api";
import { WebFileUpload } from "../agents/osfo/web-file-upload";
import { statusResponseFor, uploadRequestFor } from "./files";

describe("authenticated text-file ingress", () => {
  it("derives the owner, authority, and stable identities from server and retry facts", () => {
    const bytes = new TextEncoder().encode("Document Build source");
    const request = uploadRequestFor(
      {
        authSessionExpiresAt: new Date("2026-08-28T13:00:00.000Z"),
        authSessionId: "session-from-middleware",
        userId: "user-from-middleware",
      },
      bytes,
      {
        fileName: "source.txt",
        uploadId: "58453ab2-6d53-45b6-96b7-d4411059e63d",
      },
    );

    expect(request).toMatchObject({
      actionId: "web-file-upload:58453ab2-6d53-45b6-96b7-d4411059e63d",
      authority: {
        _tag: "AuthSession",
        authSessionId: "session-from-middleware",
        userId: "user-from-middleware",
      },
      fileId: "web:58453ab2-6d53-45b6-96b7-d4411059e63d",
      fileName: "source.txt",
      uploadId: "58453ab2-6d53-45b6-96b7-d4411059e63d",
    });
    expect(request.bytes).toEqual(bytes);
    expect(Schema.is(WebFileUpload.Request)(request)).toBe(true);
    expect("authorization" in request).toBe(false);
  });

  it("rejects an invalid retry identity at the public API boundary", () => {
    expect(
      Schema.decodeResult(FileUploadQuery)({
        fileName: "source.txt",
        uploadId: "not-a-uuid",
      })._tag,
    ).toBe("Failure");
  });

  it.effect("rejects overlong File IDs and preserves retryable status outages", () =>
    Effect.gen(function* () {
      expect(Schema.decodeResult(BrowserFileId)("x".repeat(161))._tag).toBe("Failure");
      expect(yield* statusResponseFor({ _tag: "Denied" }).pipe(Effect.result)).toMatchObject({
        failure: { _tag: "FileUploadDenied" },
      });
      expect(yield* statusResponseFor({ _tag: "Unavailable" }).pipe(Effect.result)).toMatchObject({
        failure: { _tag: "FileUploadUnavailable" },
      });
    }),
  );
});
