/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import {
  makeAccountDeletionFence,
  requireAccountDeletionQuiescence,
} from "./account-deletion-fence";

it("rejects a Think quiescence failure returned through the RPC value channel", () => {
  const failure = Object.assign(new Error("Think quiescence failed"), {
    _tag: "ThinkSubmissionUnavailable" as const,
  });
  expect(() => requireAccountDeletionQuiescence(failure)).toThrow(failure);
  expect(requireAccountDeletionQuiescence(undefined)).toBeUndefined();
});

it.effect("drains an in-flight document writer and prevents resurrection after R2 cleanup", () =>
  Effect.gen(function* () {
    const fence = makeAccountDeletionFence();
    const release = yield* Deferred.make<void>();
    const writes: Array<string> = [];
    const inFlight = yield* fence
      .run(
        Deferred.await(release).pipe(Effect.andThen(Effect.sync(() => writes.push("document")))),
        () => "account deletion fenced" as const,
      )
      .pipe(Effect.forkChild);
    const closing = yield* fence.close.pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    expect(writes).toEqual([]);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(inFlight);
    yield* Fiber.join(closing);
    writes.splice(0);

    const resumed = yield* fence
      .run(
        Effect.sync(() => writes.push("orphan")),
        () => "account deletion fenced" as const,
      )
      .pipe(Effect.flip);
    expect(resumed).toBe("account deletion fenced");
    expect(writes).toEqual([]);
  }),
);
