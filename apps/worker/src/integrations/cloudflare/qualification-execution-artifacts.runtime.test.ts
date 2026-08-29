/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect Vitest generators. */
import { expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { Effect, Exit } from "effect";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { makeQualificationExecutionArtifactStore } from "./qualification-execution-artifacts";

const key = "qualification/runtime-tests/immutable-concurrency.json";

it.effect("uses real R2 create-only preconditions for retries and concurrent writers", () =>
  Effect.gen(function* () {
    yield* Effect.promise(() => env.ARTIFACTS.delete(key));
    const store = makeQualificationExecutionArtifactStore(env.ARTIFACTS);

    yield* store.writeImmutable(key, "same");
    yield* store.writeImmutable(key, "same");
    yield* Effect.promise(() => env.ARTIFACTS.delete(key));

    const exits = yield* Effect.all(
      [
        Effect.exit(store.writeImmutable(key, "first")),
        Effect.exit(store.writeImmutable(key, "second")),
      ],
      { concurrency: "unbounded" },
    );
    const retained = yield* store.read(key);

    expect(exits.filter(Exit.isSuccess)).toHaveLength(1);
    expect(exits.filter(Exit.isFailure)).toHaveLength(1);
    expect(["first", "second"]).toContain(retained);
    yield* Effect.promise(() => env.ARTIFACTS.delete(key));
  }),
);

it.effect("lists immutable R2 shard checksums and custom metadata without reading bodies", () =>
  Effect.gen(function* () {
    const shardKey = "qualification/runtime-tests/authority/00000000.json";
    const body = new TextEncoder().encode('{"records":["authority"]}');
    const bodySha256 = sha256(body);
    const customMetadata = {
      "osfo-component": "arrivals",
      "osfo-index": "0",
      "osfo-kind": "qualification-authority-stream-v1",
    };
    yield* Effect.promise(() => env.ARTIFACTS.delete(shardKey));
    yield* Effect.promise(() =>
      env.ARTIFACTS.put(shardKey, body, {
        customMetadata,
        sha256: bodySha256,
      }),
    );

    const page = yield* Effect.promise(() =>
      env.ARTIFACTS.list({
        include: ["customMetadata"],
        prefix: "qualification/runtime-tests/authority/",
      }),
    );
    const listed = page.objects.find(({ key: objectKey }) => objectKey === shardKey);

    expect(listed?.customMetadata).toEqual(customMetadata);
    const listedSha256 = listed?.checksums.sha256;
    expect(listedSha256).toBeDefined();
    if (listedSha256 === undefined) return;
    expect(bytesToHex(new Uint8Array(listedSha256))).toBe(bytesToHex(bodySha256));
    yield* Effect.promise(() => env.ARTIFACTS.delete(shardKey));
  }),
);
