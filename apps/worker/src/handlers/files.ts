import {
  Api,
  CurrentUser,
  FileUploadConflict,
  FileUploadDenied,
  FileUploadLimitExceeded,
  FileUploadRejected,
  FileUploadUnavailable,
  type CurrentUserValue,
} from "@osfo/api";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { WebFileUpload } from "../agents/osfo/web-file-upload";
import { UserId } from "../domain";
import { ActionId } from "../domain/action-execution";
import { AuthSessionId } from "../domain/auth-session";
import { FileId, FileName, FileUploadId } from "../domain/file";

/* oxlint-disable eslint/no-underscore-dangle, osfo/no-unknown-parameters, osfo/no-unknown-returns, typescript/consistent-return -- Effect HTTP handlers decode untrusted Cloudflare RPC values immediately and fail through the typed error channel. */

export interface Bindings {
  readonly OSFO_DIRECTORY: {
    readonly getByName: (name: string) => {
      readonly uploadUserTextFile: (input: WebFileUpload.Request) => Promise<unknown>;
      readonly inspectUserFile: (input: WebFileUpload.StatusRequest) => Promise<unknown>;
    };
  };
}

/** Derive every trusted upload identity from the authenticated User and retry key. */
export const uploadRequestFor = (
  currentUser: CurrentUserValue,
  payload: Uint8Array,
  query: { readonly fileName: string; readonly uploadId: string },
) => {
  const uploadId = FileUploadId.make(query.uploadId);
  return WebFileUpload.Request.make({
    actionId: ActionId.make(`web-file-upload:${uploadId}`),
    authority: {
      _tag: "AuthSession",
      authSessionId: AuthSessionId.make(currentUser.authSessionId),
      userId: UserId.make(currentUser.userId),
    },
    bytes: Uint8Array.from(payload),
    fileId: FileId.make(`web:${uploadId}`),
    fileName: FileName.make(query.fileName),
    uploadId,
  });
};

/** Preserve caller denial separately from retryable Agent/file-store outages. */
export const statusResponseFor = (
  result: WebFileUpload.StatusResult,
): Effect.Effect<
  Extract<WebFileUpload.StatusResult, { readonly _tag: "Found" }>,
  FileUploadDenied | FileUploadUnavailable
> => {
  if (result._tag === "Found") return Effect.succeed(result);
  if (result._tag === "Denied") {
    return Effect.fail(new FileUploadDenied({ message: "File status is not authorized" }));
  }
  return Effect.fail(
    new FileUploadUnavailable({ message: "File status is temporarily unavailable" }),
  );
};

export const decodeUploadResult = (
  untrusted: unknown,
  expected: Pick<WebFileUpload.Request, "fileId" | "fileName">,
) =>
  Schema.decodeUnknownEffect(WebFileUpload.Result)(untrusted).pipe(
    Effect.mapError(
      () => new FileUploadUnavailable({ message: "File upload is temporarily unavailable" }),
    ),
    Effect.flatMap((result) =>
      result._tag !== "Uploaded" ||
      (result.fileId === expected.fileId && result.fileName === expected.fileName)
        ? Effect.succeed(result)
        : Effect.fail(
            new FileUploadUnavailable({ message: "File upload is temporarily unavailable" }),
          ),
    ),
  );

export const decodeStatusResult = (untrusted: unknown, expectedFileId: FileId) =>
  Schema.decodeUnknownEffect(WebFileUpload.StatusResult)(untrusted).pipe(
    Effect.mapError(
      () => new FileUploadUnavailable({ message: "File status is temporarily unavailable" }),
    ),
    Effect.flatMap((result) =>
      result._tag !== "Found" || result.fileId === expectedFileId
        ? Effect.succeed(result)
        : Effect.fail(
            new FileUploadUnavailable({ message: "File status is temporarily unavailable" }),
          ),
    ),
  );

export const uploadResponseFor = (
  result: WebFileUpload.Result,
): Effect.Effect<
  Extract<WebFileUpload.Result, { readonly _tag: "Uploaded" }>,
  | FileUploadConflict
  | FileUploadDenied
  | FileUploadLimitExceeded
  | FileUploadRejected
  | FileUploadUnavailable
> => {
  if (result._tag === "Uploaded") return Effect.succeed(result);
  switch (result.reason) {
    case "conflict":
      return Effect.fail(
        new FileUploadConflict({
          message: "The upload identity already names different file content",
        }),
      );
    case "denied":
      return Effect.fail(new FileUploadDenied({ message: "File upload is not authorized" }));
    case "invalid":
      return Effect.fail(new FileUploadRejected({ message: "The text file is invalid" }));
    case "limit":
      return Effect.fail(
        new FileUploadLimitExceeded({ message: "The retained file limit has been reached" }),
      );
    case "unavailable":
      return Effect.fail(
        new FileUploadUnavailable({ message: "File upload is temporarily unavailable" }),
      );
  }
};

/** Upload a bounded source through the authenticated User's stable Agent route. */
export const layer = (bindings: Bindings) =>
  HttpApiBuilder.group(Api, "files", (handlers) =>
    handlers
      .handle("uploadText", ({ payload, query }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const request = uploadRequestFor(currentUser, payload, query);
          const untrusted = yield* Effect.tryPromise({
            try: () =>
              bindings.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME).uploadUserTextFile(request),
            catch: () =>
              new FileUploadUnavailable({ message: "File upload is temporarily unavailable" }),
          });
          const result = yield* decodeUploadResult(untrusted, request);
          return yield* uploadResponseFor(result);
        }),
      )
      .handle("status", ({ params }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const fileId = FileId.make(params.fileId);
          const untrusted = yield* Effect.tryPromise({
            try: () =>
              bindings.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME).inspectUserFile(
                WebFileUpload.StatusRequest.make({
                  fileId,
                  userId: UserId.make(currentUser.userId),
                }),
              ),
            catch: () =>
              new FileUploadUnavailable({ message: "File status is temporarily unavailable" }),
          });
          const result = yield* decodeStatusResult(untrusted, fileId);
          return yield* statusResponseFor(result);
        }),
      ),
  );

export * as FilesHandlers from "./files";
