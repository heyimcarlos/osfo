import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";

const uploadIdentityPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Client retry identity for one authenticated browser upload. */
export const BrowserFileUploadId = Schema.String.check(
  Schema.makeFilter((value) => uploadIdentityPattern.test(value) || "must be a version 4 UUID"),
);

/** Bounded display name for one authenticated browser upload. */
export const BrowserFileName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255));

/** Public query facts for the launch text-file ingress. */
export const FileUploadQuery = Schema.Struct({
  fileName: BrowserFileName,
  uploadId: BrowserFileUploadId,
});

/** Minimal safe result after the owning Agent has normalized the source. */
export const FileUploadResponse = Schema.Struct({
  fileId: Schema.String,
  fileName: BrowserFileName,
  mediaType: Schema.Literal("text/plain"),
  state: Schema.Literals(["processing", "ready"]),
});
export type FileUploadResponse = typeof FileUploadResponse.Type;

/** Safe current lifecycle for one authenticated User-owned source. */
export const FileStatusResponse = Schema.Struct({
  fileId: Schema.String,
  fileName: BrowserFileName,
  mediaType: Schema.Literal("text/plain"),
  state: Schema.Literals(["failed", "processing", "ready"]),
});
export type FileStatusResponse = typeof FileStatusResponse.Type;

export class FileUploadRejected extends Schema.TaggedError<FileUploadRejected>()(
  "FileUploadRejected",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class FileUploadDenied extends Schema.TaggedError<FileUploadDenied>()(
  "FileUploadDenied",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class FileUploadConflict extends Schema.TaggedError<FileUploadConflict>()(
  "FileUploadConflict",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class FileUploadUnavailable extends Schema.TaggedError<FileUploadUnavailable>()(
  "FileUploadUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

const TextFileBytes = Schema.Uint8Array.check(
  Schema.makeFilter(
    (bytes) =>
      (bytes.byteLength > 0 && bytes.byteLength <= 2_000_000) ||
      "must contain between 1 and 2,000,000 bytes",
  ),
).pipe(HttpApiSchema.asUint8Array({ contentType: "application/octet-stream" }));

/** Authenticated file ingress backed by the ordinary Agent-owned File lifecycle. */
export const FilesGroup = HttpApiGroup.make("files")
  .add(
    HttpApiEndpoint.post("uploadText", "/v1/files/text", {
      error: [FileUploadConflict, FileUploadDenied, FileUploadRejected, FileUploadUnavailable],
      payload: TextFileBytes,
      query: FileUploadQuery,
      success: FileUploadResponse,
    })
      .middleware(Auth)
      .annotateMerge(
        OpenApi.annotations({
          description:
            "Upload one bounded UTF-8 text source through the authenticated User's owning Agent.",
          identifier: "files.uploadText",
          summary: "Upload text source",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("status", "/v1/files/:fileId", {
      error: [FileUploadDenied, FileUploadUnavailable],
      params: { fileId: Schema.String },
      success: FileStatusResponse,
    })
      .middleware(Auth)
      .annotateMerge(
        OpenApi.annotations({
          description: "Inspect the safe lifecycle of one authenticated User-owned source.",
          identifier: "files.status",
          summary: "Inspect file status",
        }),
      ),
  );
