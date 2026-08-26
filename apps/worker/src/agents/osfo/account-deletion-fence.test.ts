/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import {
  makeAccountDeletionFencedSessionExecution,
  makeAccountDeletionFence,
  requireAccountDeletionQuiescence,
} from "./account-deletion-fence";
import { makeSessionExecution } from "./session-execution";

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

it.effect("cancels an admitted messenger turn after its allowance write before closing", () =>
  Effect.gen(function* () {
    const fence = makeAccountDeletionFence();
    const allowanceStarted = yield* Deferred.make<void>();
    const releaseAllowance = yield* Deferred.make<void>();
    const events: Array<string> = [];
    const admittedTurn = yield* fence
      .runTracked(
        (signal) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(allowanceStarted, undefined);
            yield* Deferred.await(releaseAllowance);
            events.push("allowance-recorded");
            if (signal.aborted) return;
            events.push("provider-send");
          }),
        () => "account deletion fenced" as const,
      )
      .pipe(Effect.forkChild);

    yield* Deferred.await(allowanceStarted);
    const closing = yield* fence.close.pipe(
      Effect.andThen(Effect.sync(() => events.push("closed"))),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    expect(events).toEqual([]);

    yield* Deferred.succeed(releaseAllowance, undefined);
    yield* Fiber.join(admittedTurn);
    yield* Fiber.join(closing);
    expect(events).toEqual(["allowance-recorded", "closed"]);

    const lateTurn = yield* fence
      .runTracked(
        () => Effect.sync(() => events.push("late-provider-send")),
        () => "account deletion fenced" as const,
      )
      .pipe(Effect.flip);
    expect(lateTurn).toBe("account deletion fenced");
    expect(events).toEqual(["allowance-recorded", "closed"]);
  }),
);

it.effect("waits for an already-started messenger provider call to observe cancellation", () =>
  Effect.gen(function* () {
    const fence = makeAccountDeletionFence();
    const providerStarted = yield* Deferred.make<void>();
    const events: Array<string> = [];
    const admittedTurn = yield* fence
      .runTracked(
        (signal) =>
          Deferred.succeed(providerStarted, undefined).pipe(
            Effect.andThen(
              Effect.callback<void>((resume) => {
                const onAbort = () => {
                  events.push("provider-aborted");
                  resume(Effect.void);
                };
                if (signal.aborted) {
                  onAbort();
                  return Effect.void;
                }
                signal.addEventListener("abort", onAbort, { once: true });
                return Effect.sync(() => signal.removeEventListener("abort", onAbort));
              }),
            ),
          ),
        () => "account deletion fenced" as const,
      )
      .pipe(Effect.forkChild);

    yield* Deferred.await(providerStarted);
    yield* fence.close;
    events.push("closed");
    yield* Fiber.join(admittedTurn);

    expect(events).toEqual(["provider-aborted", "closed"]);
  }),
);

it.effect(
  "rejects an authenticated managed request when deletion closes before Agent mutation",
  () =>
    Effect.gen(function* () {
      const fence = makeAccountDeletionFence();
      const sessionExecution = makeSessionExecution({ hasPendingOrRunning: Effect.succeed(false) });
      const execution = makeAccountDeletionFencedSessionExecution(sessionExecution, fence);
      const authenticated = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const mutations = {
        currentSession: new Array<string>(),
        localMessages: new Array<string>(),
        outbox: new Array<string>(),
        provider: new Array<string>(),
        sessions: new Array<string>(),
      };
      const request = yield* Deferred.succeed(authenticated, undefined).pipe(
        Effect.andThen(Deferred.await(resume)),
        Effect.andThen(
          execution.run(
            Effect.sync(() => {
              mutations.currentSession.push("changed");
              mutations.localMessages.push("written");
              mutations.outbox.push("enqueued");
              mutations.provider.push("sent");
              mutations.sessions.push("created");
            }),
            () => "account deletion fenced" as const,
          ),
        ),
        Effect.flip,
        Effect.forkChild,
      );

      yield* Deferred.await(authenticated);
      yield* execution.close;
      yield* Deferred.succeed(resume, undefined);

      expect(yield* Fiber.join(request)).toBe("account deletion fenced");
      expect(mutations).toEqual({
        currentSession: [],
        localMessages: [],
        outbox: [],
        provider: [],
        sessions: [],
      });
    }),
);

it.effect("drains a managed request already inside the fence before quiescence closes", () =>
  Effect.gen(function* () {
    const fence = makeAccountDeletionFence();
    const sessionExecution = makeSessionExecution({ hasPendingOrRunning: Effect.succeed(false) });
    const execution = makeAccountDeletionFencedSessionExecution(sessionExecution, fence);
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const events: Array<string> = [];
    const request = yield* execution
      .run(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.sync(() => events.push("request-complete"))),
        ),
        () => "account deletion fenced" as const,
      )
      .pipe(Effect.forkChild);

    yield* Deferred.await(started);
    const closing = yield* execution.close.pipe(
      Effect.andThen(Effect.sync(() => events.push("fence-closed"))),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    expect(events).toEqual([]);

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(request);
    yield* Fiber.join(closing);
    expect(events).toEqual(["request-complete", "fence-closed"]);
  }),
);

it.effect("fences messenger /new admission and continuation as one tracked execution", () =>
  Effect.gen(function* () {
    const fence = makeAccountDeletionFence();
    const sessionExecution = makeSessionExecution({ hasPendingOrRunning: Effect.succeed(false) });
    const execution = makeAccountDeletionFencedSessionExecution(sessionExecution, fence);
    const authenticated = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const events = new Array<string>();
    const request = yield* Deferred.succeed(authenticated, undefined).pipe(
      Effect.andThen(Deferred.await(resume)),
      Effect.andThen(
        execution.runTrackedWhenIdle(
          () => Effect.sync(() => events.push("replacement")),
          (_admission, _signal) => Effect.sync(() => events.push("provider-send")),
          () => "account deletion fenced" as const,
        ),
      ),
      Effect.flip,
      Effect.forkChild,
    );

    yield* Deferred.await(authenticated);
    yield* execution.close;
    yield* Deferred.succeed(resume, undefined);

    expect(yield* Fiber.join(request)).toBe("account deletion fenced");
    expect(events).toEqual([]);
  }),
);

it.effect(
  "drains an admitted messenger /new continuation without reentrant fence acquisition",
  () =>
    Effect.gen(function* () {
      const fence = makeAccountDeletionFence();
      const sessionExecution = makeSessionExecution({ hasPendingOrRunning: Effect.succeed(false) });
      const execution = makeAccountDeletionFencedSessionExecution(sessionExecution, fence);
      const continuationStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const events = new Array<string>();
      const request = yield* execution
        .runTrackedWhenIdle(
          () => Effect.sync(() => events.push("replacement")),
          (_admission, signal) =>
            Deferred.succeed(continuationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                Effect.sync(() => {
                  events.push(signal.aborted ? "provider-aborted" : "provider-send");
                }),
              ),
            ),
          () => "account deletion fenced" as const,
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(continuationStarted);
      const closing = yield* execution.close.pipe(
        Effect.andThen(Effect.sync(() => events.push("closed"))),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      expect(events).toEqual(["replacement"]);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(request);
      yield* Fiber.join(closing);
      expect(events).toEqual(["replacement", "provider-aborted", "closed"]);
    }),
);

for (const operation of ["analyzeFile", "deleteFile"] as const) {
  it.effect(`${operation} rejects after close without mutating Agent, R2, compute, or outbox`, () =>
    Effect.gen(function* () {
      const fence = makeAccountDeletionFence();
      const mutations = new Array<string>();

      yield* fence.close;
      const result = yield* fence
        .run(
          Effect.sync(() => mutations.push("mutation")),
          () => "account deletion fenced" as const,
        )
        .pipe(Effect.flip);

      expect(result).toBe("account deletion fenced");
      expect(mutations).toEqual([]);
    }),
  );

  it.effect(`${operation} drains in-flight work before account deletion closes`, () =>
    Effect.gen(function* () {
      const fence = makeAccountDeletionFence();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const events = new Array<string>();
      const request = yield* fence
        .run(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.sync(() => events.push(`${operation}-complete`))),
          ),
          () => "account deletion fenced" as const,
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(started);
      const closing = yield* fence.close.pipe(
        Effect.andThen(Effect.sync(() => events.push("closed"))),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      expect(events).toEqual([]);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(request);
      yield* Fiber.join(closing);
      expect(events).toEqual([`${operation}-complete`, "closed"]);
    }),
  );
}
