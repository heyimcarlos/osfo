/* oxlint-disable vitest/no-standalone-expect, eslint/no-underscore-dangle -- Effect test callbacks assert canonical tagged failures. */
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import { UserId } from "../../domain";
import { AccountResetFence } from "./account-reset-fence";
import { makeAccountDeletionFence } from "./account-deletion-fence";

const userId = UserId.make("reset-user");
const otherUserId = UserId.make("other-user");

const storageFor = (values = new Map<string, unknown>()) => ({
  get: (key: string) => values.get(key),
  put: (key: string, value: UserId) => {
    values.set(key, value);
  },
});

it.effect("rejects a different owner and an unsuspended owner before retaining reset state", () =>
  Effect.gen(function* () {
    const reset = AccountResetFence.make(storageFor());
    const wrongOwner = yield* AccountResetFence.requireResetAuthority(userId, otherUserId, {
      _tag: "SuspendedUser",
      userId,
    }).pipe(Effect.andThen(reset.persist(userId)), Effect.flip);
    const activeOwner = yield* AccountResetFence.requireResetAuthority(userId, userId, {
      _tag: "ActiveUser",
      userId,
    }).pipe(Effect.andThen(reset.persist(userId)), Effect.flip);
    const otherSuspension = yield* AccountResetFence.requireResetAuthority(userId, userId, {
      _tag: "SuspendedUser",
      userId: otherUserId,
    }).pipe(Effect.andThen(reset.persist(userId)), Effect.flip);
    expect(wrongOwner._tag).toBe("AccountResetUnavailable");
    expect(activeOwner._tag).toBe("AccountResetUnavailable");
    expect(otherSuspension._tag).toBe("AccountResetUnavailable");
    expect(yield* reset.isFenced).toBe(false);
  }),
);

it.effect("leaves ordinary suspension without a reset marker unfenced", () =>
  Effect.gen(function* () {
    const reset = AccountResetFence.make(storageFor());
    const executions = makeAccountDeletionFence();
    yield* AccountResetFence.requireResetAuthority(userId, userId, {
      _tag: "SuspendedUser",
      userId,
    });
    yield* reset.restore(executions.close);
    expect(yield* reset.isFenced).toBe(false);
    expect(yield* executions.run(Effect.succeed("admitted"), () => "closed")).toBe("admitted");
  }),
);

it.effect("restores a persisted fence after eviction without depending on current suspension", () =>
  Effect.gen(function* () {
    const storage = storageFor();
    const beforeEviction = AccountResetFence.make(storage);
    yield* AccountResetFence.requireResetAuthority(userId, userId, {
      _tag: "SuspendedUser",
      userId,
    });
    yield* beforeEviction.persist(userId);
    const afterEviction = AccountResetFence.make(storage);
    const executions = makeAccountDeletionFence();
    yield* afterEviction.restore(executions.close);
    expect(yield* afterEviction.isFenced).toBe(true);
    expect(yield* executions.run(Effect.succeed("write"), () => "closed").pipe(Effect.flip)).toBe(
      "closed",
    );
    yield* afterEviction.persist(userId);
    expect(yield* afterEviction.isFenced).toBe(true);
  }),
);

it.effect("retains the marker while admitted work drains and rejects late execution", () =>
  Effect.gen(function* () {
    const storage = storageFor();
    const reset = AccountResetFence.make(storage);
    const executions = makeAccountDeletionFence();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const events: Array<string> = [];
    const admitted = yield* executions
      .runTracked(
        (signal) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(
              Effect.sync(() => {
                expect(signal.aborted).toBe(true);
                events.push("settled");
              }),
            ),
          ),
        () => "closed",
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* reset.persist(userId);
    const closing = yield* executions.close.pipe(
      Effect.andThen(Effect.sync(() => events.push("quiesced"))),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    expect(yield* reset.isFenced).toBe(true);
    expect(events).toEqual([]);
    expect(yield* executions.run(Effect.succeed("late"), () => "closed").pipe(Effect.flip)).toBe(
      "closed",
    );
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(admitted);
    yield* Fiber.join(closing);
    expect(events).toEqual(["settled", "quiesced"]);
    expect(yield* AccountResetFence.make(storage).isFenced).toBe(true);
  }),
);

it.effect("fails closed on unreadable persistence and never overwrites another reset owner", () =>
  Effect.gen(function* () {
    const unavailable = AccountResetFence.make({
      get: () => {
        throw new Error("storage unavailable");
      },
      put: () => {
        throw new Error("unexpected write");
      },
    });
    expect((yield* unavailable.isFenced.pipe(Effect.flip))._tag).toBe("AccountResetUnavailable");
    expect((yield* unavailable.restore(Effect.void).pipe(Effect.flip))._tag).toBe(
      "AccountResetUnavailable",
    );
    const values = new Map<string, unknown>();
    const reset = AccountResetFence.make(storageFor(values));
    yield* reset.persist(userId);
    expect((yield* reset.persist(otherUserId).pipe(Effect.flip))._tag).toBe(
      "AccountResetUnavailable",
    );
    expect([...values.values()]).toEqual([userId]);
  }),
);
