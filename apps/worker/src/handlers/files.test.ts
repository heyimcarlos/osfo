/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect, eslint/no-underscore-dangle, vitest/no-standalone-expect -- Fixed middleware timestamps and Effect test callbacks make ingress evidence deterministic. */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  BrowserFileId,
  BrowserTextFileBytes,
  FileUploadQuery,
  maximumBrowserTextUploadBytes,
} from "@osfo/api";
import { WebFileUpload } from "../agents/osfo/web-file-upload";
import {
  decodeStatusResult,
  decodeUploadResult,
  statusResponseFor,
  uploadRequestFor,
  uploadResponseFor,
} from "./files";

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

  it("accepts raw text above two MB through the public boundary and retains the 25 MB cap", () => {
    const aboveNormalizationLimit = new Uint8Array(2_000_001);
    const request = uploadRequestFor(
      {
        authSessionExpiresAt: new Date("2026-08-28T13:00:00.000Z"),
        authSessionId: "session-from-middleware",
        userId: "user-from-middleware",
      },
      aboveNormalizationLimit,
      {
        fileName: "source.txt",
        uploadId: "58453ab2-6d53-45b6-96b7-d4411059e63d",
      },
    );

    expect(Schema.decodeResult(BrowserTextFileBytes)(aboveNormalizationLimit)._tag).toBe("Success");
    expect(request.bytes.byteLength).toBe(2_000_001);
    expect(
      Schema.decodeResult(BrowserTextFileBytes)(new Uint8Array(maximumBrowserTextUploadBytes + 1))
        ._tag,
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

  it.effect("rejects malformed Directory upload and status responses as transient", () =>
    Effect.gen(function* () {
      const request = uploadRequestFor(
        {
          authSessionExpiresAt: new Date("2026-08-28T13:00:00.000Z"),
          authSessionId: "session-from-middleware",
          userId: "user-from-middleware",
        },
        new TextEncoder().encode("source"),
        { fileName: "source.txt", uploadId: "58453ab2-6d53-45b6-96b7-d4411059e63d" },
      );
      expect(
        yield* decodeUploadResult({ _tag: "Uploaded" }, request).pipe(Effect.result),
      ).toMatchObject({
        failure: { _tag: "FileUploadUnavailable" },
      });
      expect(
        yield* decodeStatusResult({ _tag: "Unknown" }, request.fileId).pipe(Effect.result),
      ).toMatchObject({
        failure: { _tag: "FileUploadUnavailable" },
      });
    }),
  );

  it.effect("rejects schema-valid upload and status results with mismatched identities", () =>
    Effect.gen(function* () {
      const request = uploadRequestFor(
        {
          authSessionExpiresAt: new Date("2026-08-28T13:00:00.000Z"),
          authSessionId: "session-from-middleware",
          userId: "user-from-middleware",
        },
        new TextEncoder().encode("source"),
        { fileName: "source.txt", uploadId: "58453ab2-6d53-45b6-96b7-d4411059e63d" },
      );
      const wrongUpload = {
        _tag: "Uploaded" as const,
        fileId: "web:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        fileName: "other.txt",
        mediaType: "text/plain" as const,
        state: "ready" as const,
      };
      const wrongStatus = {
        _tag: "Found" as const,
        fileId: "web:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        fileName: "source.txt",
        mediaType: "text/plain" as const,
        state: "ready" as const,
      };

      expect(yield* decodeUploadResult(wrongUpload, request).pipe(Effect.result)).toMatchObject({
        failure: { _tag: "FileUploadUnavailable" },
      });
      expect(
        yield* decodeStatusResult(wrongStatus, request.fileId).pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "FileUploadUnavailable" } });
    }),
  );

  it.effect("preserves the retained-file limit as a non-retryable 413 failure", () =>
    Effect.gen(function* () {
      expect(
        yield* uploadResponseFor({ _tag: "Rejected", reason: "limit" }).pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "FileUploadLimitExceeded" } });
    }),
  );
});
