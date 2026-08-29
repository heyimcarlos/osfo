/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect Vitest generators. */
import { expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { Effect, Exit } from "effect";

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
