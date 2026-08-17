import { Effect, Schema } from "effect";

import { FileDigest } from "../../domain/file-content";
import type { FileObjects } from "../../services/files";

/* oxlint-disable effecttsgo/async-function -- Cloudflare R2 exposes Promise-only body and request boundaries. */

/** Expected Cloudflare R2 dependency failure at the file object boundary. */
export class FileObjectStoreUnavailable extends Schema.TaggedError<FileObjectStoreUnavailable>()(
  "FileObjectStoreUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

/** Expected rejection when retained R2 metadata is missing or malformed. */
export class FileObjectMetadataInvalid extends Schema.TaggedError<FileObjectMetadataInvalid>()(
  "FileObjectMetadataInvalid",
  { key: Schema.String, message: Schema.String },
) {}

/** Construct immutable file object operations from one private R2 binding. */
export const makeR2FileObjects = (
  bucket: R2Bucket,
): FileObjects<FileObjectStoreUnavailable | FileObjectMetadataInvalid> => ({
  delete: (key) => request("delete", () => bucket.delete(key)),
  get: (key) =>
    request("get", async () => {
      const object = await bucket.get(key);
      return object === null ? null : await object.bytes();
    }),
  put: (key, bytes, sha256) =>
    request("put", async () => {
      const checksum = checksumBytes(sha256);
      await bucket.put(key, bytes, {
        customMetadata: { "osfo-sha256": sha256 },
        sha256: checksum,
      });
    }),
  stat: (key) =>
    request("stat", () => bucket.head(key)).pipe(
      Effect.flatMap((object) => {
        if (object === null) return Effect.succeed(null);
        const encodedDigest = object.customMetadata?.["osfo-sha256"];
        return Schema.decodeUnknownEffect(FileDigest)(encodedDigest).pipe(
          Effect.map((sha256) => ({ byteLength: BigInt(object.size), sha256 })),
          Effect.mapError(
            () =>
              new FileObjectMetadataInvalid({
                key,
                message: "R2 file metadata has no valid source digest",
              }),
          ),
        );
      }),
    ),
});

const checksumBytes = (digest: FileDigest): Uint8Array => {
  const hex = digest.slice("sha256:".length);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const request = <A>(
  operation: string,
  perform: () => Promise<A>,
): Effect.Effect<A, FileObjectStoreUnavailable> =>
  Effect.tryPromise({
    try: perform,
    catch: (cause) =>
      new FileObjectStoreUnavailable({
        cause,
        message: "Cloudflare R2 could not complete a file object operation",
        operation,
      }),
  });
