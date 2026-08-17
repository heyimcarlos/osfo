import { Effect, Schema } from "effect";

/** Media types accepted by the launch file capability. */
export const FileMediaType = Schema.Literals([
  "text/plain",
  "text/csv",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Media types accepted by the launch file capability. */
export type FileMediaType = typeof FileMediaType.Type;

/** SHA-256 digest rendered in the stable Osfo content-reference form. */
export const FileDigest = Schema.String.check(
  Schema.makeFilter(
    (value) => /^sha256:[0-9a-f]{64}$/u.test(value) || "must be a SHA-256 content digest",
  ),
).pipe(Schema.brand("FileDigest"));

/** SHA-256 digest rendered in the stable Osfo content-reference form. */
export type FileDigest = typeof FileDigest.Type;

/** Trusted facts derived from the complete bounded upload bytes. */
export const InspectedFileContent = Schema.Struct({
  byteLength: Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)),
  mediaType: FileMediaType,
  sha256: FileDigest,
});

/** Trusted facts derived from the complete bounded upload bytes. */
export type InspectedFileContent = typeof InspectedFileContent.Type;

/** Expected rejection for a media type outside the launch contract. */
export class UnsupportedFileMedia extends Schema.TaggedError<UnsupportedFileMedia>()(
  "UnsupportedFileMedia",
  { declaredMediaType: Schema.String, message: Schema.String },
) {}

/** Expected rejection when declared media does not match the uploaded bytes. */
export class FileMediaMismatch extends Schema.TaggedError<FileMediaMismatch>()(
  "FileMediaMismatch",
  { declaredMediaType: FileMediaType, message: Schema.String },
) {}

/** Expected rejection when uploaded bytes are empty or unsafe for their media family. */
export class InvalidFileContent extends Schema.TaggedError<InvalidFileContent>()(
  "InvalidFileContent",
  { message: Schema.String },
) {}

/** Inspect complete upload bytes and derive trusted media, length, and digest facts. */
export const inspectFileContent = (input: {
  readonly bytes: Uint8Array;
  readonly declaredMediaType: string;
}): Effect.Effect<
  InspectedFileContent,
  UnsupportedFileMedia | FileMediaMismatch | InvalidFileContent
> =>
  Effect.gen(function* () {
    const mediaType = yield* Schema.decodeUnknownEffect(FileMediaType)(
      input.declaredMediaType,
    ).pipe(
      Effect.mapError(
        () =>
          new UnsupportedFileMedia({
            declaredMediaType: input.declaredMediaType,
            message: "The declared media type is not supported",
          }),
      ),
    );
    if (input.bytes.byteLength === 0) {
      return yield* new InvalidFileContent({ message: "File content must not be empty" });
    }
    if ((mediaType === "text/plain" || mediaType === "text/csv") && !isUtf8Text(input.bytes)) {
      return yield* new InvalidFileContent({
        message: "Text and CSV uploads must contain valid UTF-8 text without null bytes",
      });
    }
    if (!matchesMedia(mediaType, input.bytes)) {
      return yield* new FileMediaMismatch({
        declaredMediaType: mediaType,
        message: "The uploaded bytes do not match the declared media type",
      });
    }
    const digestBytes = Uint8Array.from(input.bytes);
    const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", digestBytes.buffer));
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return InspectedFileContent.make({
      byteLength: BigInt(input.bytes.byteLength),
      mediaType,
      sha256: FileDigest.make(`sha256:${hex}`),
    });
  });

const matchesMedia = (mediaType: FileMediaType, bytes: Uint8Array): boolean => {
  switch (mediaType) {
    case "text/plain":
    case "text/csv":
      return isUtf8Text(bytes);
    case "application/pdf":
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return (
        startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
      );
    case "image/webp":
      return (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        bytes.byteLength >= 12 &&
        startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
      );
    default:
      return false;
  }
};

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>): boolean =>
  bytes.byteLength >= signature.length && signature.every((byte, index) => bytes[index] === byte);

const isUtf8Text = (bytes: Uint8Array): boolean => {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};
