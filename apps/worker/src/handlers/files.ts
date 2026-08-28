import {
  Api,
  CurrentUser,
  FileUploadConflict,
  FileUploadDenied,
  FileUploadRejected,
  FileUploadUnavailable,
  type CurrentUserValue,
} from "@osfo/api";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { WebFileUpload } from "../agents/osfo/web-file-upload";
import { UserId } from "../domain";
import { ActionId } from "../domain/action-execution";
import { AuthSessionId } from "../domain/auth-session";
import { FileId, FileName, FileUploadId } from "../domain/file";

/* oxlint-disable eslint/no-underscore-dangle, typescript/consistent-return -- Effect HTTP handlers branch over decoded RPC outcomes and fail through the typed error channel. */

export interface Bindings {
  readonly OSFO_DIRECTORY: {
    readonly getByName: (name: string) => {
      readonly uploadUserTextFile: (input: WebFileUpload.Request) => Promise<WebFileUpload.Result>;
      readonly inspectUserFile: (
        input: WebFileUpload.StatusRequest,
      ) => Promise<WebFileUpload.StatusResult>;
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

/** Upload a bounded source through the authenticated User's stable Agent route. */
export const layer = (bindings: Bindings) =>
  HttpApiBuilder.group(Api, "files", (handlers) =>
    handlers
      .handle("uploadText", ({ payload, query }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const result = yield* Effect.tryPromise({
            try: () =>
              bindings.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME).uploadUserTextFile(
                uploadRequestFor(currentUser, payload, query),
              ),
            catch: () =>
              new FileUploadUnavailable({ message: "File upload is temporarily unavailable" }),
          });
          if (result._tag === "Uploaded") return result;
          switch (result.reason) {
            case "conflict":
              return yield* new FileUploadConflict({
                message: "The upload identity already names different file content",
              });
            case "denied":
              return yield* new FileUploadDenied({ message: "File upload is not authorized" });
            case "invalid":
              return yield* new FileUploadRejected({ message: "The text file is invalid" });
            case "unavailable":
              return yield* new FileUploadUnavailable({
                message: "File upload is temporarily unavailable",
              });
          }
        }),
      )
      .handle("status", ({ params }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const result = yield* Effect.tryPromise({
            try: () =>
              bindings.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME).inspectUserFile(
                WebFileUpload.StatusRequest.make({
                  fileId: FileId.make(params.fileId),
                  userId: UserId.make(currentUser.userId),
                }),
              ),
            catch: () =>
              new FileUploadUnavailable({ message: "File status is temporarily unavailable" }),
          });
          if (result._tag === "Found") return result;
          return yield* new FileUploadDenied({ message: "File status is not authorized" });
        }),
      ),
  );

export * as FilesHandlers from "./files";
