/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";

import { ConversationRouteId, SessionId } from "../../domain";
import { DbTimestamp } from "../../db";
import { deleteLocalSession } from "./session-deletion";

it.effect(
  "retains local Session history when authority changes immediately before clearing",
  () => {
    const events: Array<string> = [];
    return Effect.gen(function* () {
      const result = yield* deleteLocalSession(
        {
          replacementSessionId: SessionId.make("session-2"),
          sessionId: SessionId.make("session-1"),
        },
        {
          activateCurrentSession: record(events, "activate"),
          authorizeDeletion: record(events, "recheck").pipe(
            Effect.andThen(Effect.fail(new TestAuthorityChanged())),
          ),
          clearMessages: () => record(events, "clear"),
          inspect: record(events, "inspect").pipe(
            Effect.as({
              currentSessionId: SessionId.make("session-1"),
              routeId: ConversationRouteId.make("route-1"),
            }),
          ),
          ownsSession: () => record(events, "owns").pipe(Effect.as(true)),
          replacedAt: Effect.succeed(DbTimestamp.make("2026-08-25T12:00:00.000Z")),
          replaceCurrentSession: () => record(events, "replace"),
          settle: () => record(events, "settle"),
        },
      ).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(events).toEqual(["owns", "inspect", "replace", "activate", "recheck"]);
    });
  },
);

it.effect("retries a retained Session deletion after the initial local clear fails", () => {
  const events: Array<string> = [];
  const deletedSessionId = SessionId.make("session-1");
  const replacementSessionId = SessionId.make("session-2");
  let currentSessionId = deletedSessionId;
  let clearAttempts = 0;
  let owned = true;
  const run = () =>
    deleteLocalSession(
      { replacementSessionId, sessionId: deletedSessionId },
      {
        activateCurrentSession: record(events, "activate"),
        authorizeDeletion: record(events, "recheck-retained-authorization"),
        clearMessages: () =>
          Effect.suspend(() => {
            clearAttempts += 1;
            events.push(`clear-${clearAttempts}`);
            return clearAttempts === 1 ? Effect.fail(new TestLocalClearUnavailable()) : Effect.void;
          }),
        inspect: Effect.sync(() => ({
          currentSessionId,
          routeId: ConversationRouteId.make("route-1"),
        })),
        ownsSession: () => Effect.sync(() => owned),
        replacedAt: Effect.succeed(DbTimestamp.make("2026-08-25T12:00:00.000Z")),
        replaceCurrentSession: () =>
          Effect.sync(() => {
            currentSessionId = replacementSessionId;
            events.push("replace");
          }),
        settle: () =>
          Effect.sync(() => {
            owned = false;
            events.push("settle");
          }),
      },
    );

  return Effect.gen(function* () {
    const first = yield* run().pipe(Effect.result);
    expect(Result.isFailure(first)).toBe(true);
    yield* run();

    expect(owned).toBe(false);
    expect(events).toEqual([
      "replace",
      "activate",
      "recheck-retained-authorization",
      "clear-1",
      "recheck-retained-authorization",
      "clear-2",
      "settle",
    ]);
  });
});

const record = (events: Array<string>, event: string) =>
  Effect.sync(() => {
    events.push(event);
  });

class TestAuthorityChanged extends Schema.TaggedError<TestAuthorityChanged>()(
  "TestAuthorityChanged",
  {},
) {}

class TestLocalClearUnavailable extends Schema.TaggedError<TestLocalClearUnavailable>()(
  "TestLocalClearUnavailable",
  {},
) {}
