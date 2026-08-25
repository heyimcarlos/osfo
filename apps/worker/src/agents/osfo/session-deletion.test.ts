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

const record = (events: Array<string>, event: string) =>
  Effect.sync(() => {
    events.push(event);
  });

class TestAuthorityChanged extends Schema.TaggedError<TestAuthorityChanged>()(
  "TestAuthorityChanged",
  {},
) {}
