/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect tests. */
import { expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { Effect, Exit } from "effect";

import { FileDigest } from "../../domain/file-content";
import { makeR2FileObjects } from "./file-objects";

const digest = FileDigest.make(
  "sha256:d7a6eeb9ea1e679086bf7290262c26a4e1f5ca95d6f90f02c2e3abe659367b2c",
);
const bytes = new TextEncoder().encode(
  "Osfo disposable qualification document source v1.\nThis file verifies the real Document Build file boundary.\n",
);

it.effect("authenticates File metadata against the native R2 SHA-256", () =>
  Effect.gen(function* () {
    const objects = makeR2FileObjects(env.FILES);
    const validKey = "qualification-file-object-valid";
    yield* objects.delete(validKey);
    yield* objects.put(validKey, bytes, digest);
    expect(yield* objects.stat(validKey)).toEqual({ byteLength: 108n, sha256: digest });

    const staleMetadataKey = "qualification-file-object-stale-metadata";
    yield* Effect.promise(() =>
      env.FILES.put(staleMetadataKey, new Uint8Array(bytes.length).fill(1), {
        customMetadata: { "osfo-sha256": digest },
      }),
    );
    expect(Exit.isFailure(yield* Effect.exit(objects.stat(staleMetadataKey)))).toBe(true);

    const missingNativeKey = "qualification-file-object-missing-native";
    yield* Effect.promise(() =>
      env.FILES.put(missingNativeKey, bytes, { customMetadata: { "osfo-sha256": digest } }),
    );
    expect(Exit.isFailure(yield* Effect.exit(objects.stat(missingNativeKey)))).toBe(true);

    const missingMetadataKey = "qualification-file-object-missing-metadata";
    yield* Effect.promise(() =>
      env.FILES.put(missingMetadataKey, bytes, { sha256: checksumBytes }),
    );
    expect(Exit.isFailure(yield* Effect.exit(objects.stat(missingMetadataKey)))).toBe(true);
  }),
);

const checksumBytes = Uint8Array.from(
  digest
    .slice("sha256:".length)
    .match(/.{2}/gu)
    ?.map((byte) => Number.parseInt(byte, 16)) ?? [],
);
