/* oxlint-disable effecttsgo/global-date, eslint/no-underscore-dangle -- Fixed middleware timestamps and standard Effect discriminators make ingress evidence deterministic. */
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { FileUploadQuery } from "@osfo/api";
import { WebFileUpload } from "../agents/osfo/web-file-upload";
import { uploadRequestFor } from "./files";

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
});
