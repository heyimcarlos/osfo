import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { inspectFileContent } from "../src/domain/file-content";

/* oxlint-disable eslint/no-underscore-dangle -- Effect tagged failures expose their stable `_tag` discriminator. */

describe("file content boundary", () => {
  it.effect("accepts every launch media family from trusted bytes", () =>
    Effect.gen(function* () {
      const cases = [
        ["text/plain", new TextEncoder().encode("hello")],
        ["text/csv", new TextEncoder().encode("name,value\nA,1\n")],
        ["application/pdf", new TextEncoder().encode("%PDF-1.7\n")],
        [
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
        ],
        ["image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        ["image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])],
        ["image/gif", new TextEncoder().encode("GIF89a")],
        ["image/webp", new TextEncoder().encode("RIFF1234WEBP")],
      ] as const;

      for (const [mediaType, bytes] of cases) {
        const inspected = yield* inspectFileContent({ bytes, declaredMediaType: mediaType });
        expect(inspected.mediaType).toBe(mediaType);
        expect(inspected.byteLength).toBe(BigInt(bytes.byteLength));
        expect(inspected.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    }),
  );

  it.effect("rejects unsupported, spoofed, empty, and binary text content", () =>
    Effect.gen(function* () {
      const unsupported = yield* Effect.flip(
        inspectFileContent({
          bytes: new TextEncoder().encode("{}"),
          declaredMediaType: "application/json",
        }),
      );
      const spoofed = yield* Effect.flip(
        inspectFileContent({
          bytes: new TextEncoder().encode("not a pdf"),
          declaredMediaType: "application/pdf",
        }),
      );
      const empty = yield* Effect.flip(
        inspectFileContent({ bytes: new Uint8Array(), declaredMediaType: "text/plain" }),
      );
      const binaryText = yield* Effect.flip(
        inspectFileContent({
          bytes: Uint8Array.from([0x61, 0, 0x62]),
          declaredMediaType: "text/plain",
        }),
      );

      expect(unsupported._tag).toBe("UnsupportedFileMedia");
      expect(spoofed._tag).toBe("FileMediaMismatch");
      expect(empty._tag).toBe("InvalidFileContent");
      expect(binaryText._tag).toBe("InvalidFileContent");
    }),
  );
});
