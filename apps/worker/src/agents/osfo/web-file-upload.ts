import { Schema } from "effect";

import { UserId } from "../../domain";
import { ActionId } from "../../domain/action-execution";
import { AuthSessionId } from "../../domain/auth-session";
import { FileId, FileName, FileUploadId } from "../../domain/file";

/** Trusted request constructed only after HTTP authentication. */
export const Request = Schema.Struct({
  actionId: ActionId,
  authority: Schema.TaggedStruct("AuthSession", {
    authSessionId: AuthSessionId,
    userId: UserId,
  }),
  bytes: Schema.instanceOf(Uint8Array),
  fileId: FileId,
  fileName: FileName,
  uploadId: FileUploadId,
});
export type Request = typeof Request.Type;

/** Minimal private RPC result with no object key, allowance, or upload lifecycle facts. */
export const Result = Schema.Union([
  Schema.TaggedStruct("Uploaded", {
    fileId: FileId,
    fileName: FileName,
    mediaType: Schema.Literal("text/plain"),
    state: Schema.Literals(["processing", "ready"]),
  }),
  Schema.TaggedStruct("Rejected", {
    reason: Schema.Literals(["conflict", "denied", "invalid", "unavailable"]),
  }),
]);
export type Result = typeof Result.Type;

export const StatusRequest = Schema.Struct({ fileId: FileId, userId: UserId });
export type StatusRequest = typeof StatusRequest.Type;

export const StatusResult = Schema.Union([
  Schema.TaggedStruct("Found", {
    fileId: FileId,
    fileName: FileName,
    mediaType: Schema.Literal("text/plain"),
    state: Schema.Literals(["failed", "processing", "ready"]),
  }),
  Schema.TaggedStruct("Denied", {}),
  Schema.TaggedStruct("Unavailable", {}),
]);
export type StatusResult = typeof StatusResult.Type;

export * as WebFileUpload from "./web-file-upload";
