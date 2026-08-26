/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";

import { ConversationRouteId, SessionId } from "../../domain";
import { DbTimestamp } from "../../db";
import { deleteLocalSession } from "./session-deletion";

it.effect("does not replace the current Session when authority changes before replacement", () => {
  const events: Array<string> = [];
  return Effect.gen(function* () {
    const result = yield* deleteLocalSession(
      {
        replacementSessionId: SessionId.make("session-2"),
        sessionId: SessionId.make("session-1"),
      },
      {
        activateCurrentSession: record(events, "activate"),
        authorizeDeletion: () =>
          record(events, "recheck").pipe(Effect.andThen(Effect.fail(new TestAuthorityChanged()))),
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
        rollbackCurrentSessionReplacement: () =>
          Effect.die(new Error("A replacement was rolled back before it existed")),
        settle: () => record(events, "settle"),
      },
    ).pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
    expect(events).toEqual(["owns", "inspect", "recheck"]);
  });
});

it.effect("rolls back the replacement when authority changes before activation", () => {
  const events: Array<string> = [];
  const deletedSessionId = SessionId.make("session-1");
  const replacementSessionId = SessionId.make("session-2");
  let checks = 0;
  let currentSessionId = deletedSessionId;

  return Effect.gen(function* () {
    const result = yield* deleteLocalSession(
      { replacementSessionId, sessionId: deletedSessionId },
      {
        activateCurrentSession: record(events, "activate"),
        authorizeDeletion: () =>
          Effect.suspend(() => {
            events.push("recheck");
            checks += 1;
            return checks === 1 ? Effect.void : Effect.fail(new TestAuthorityChanged());
          }),
        clearMessages: () => record(events, "clear"),
        inspect: Effect.succeed({
          currentSessionId,
          routeId: ConversationRouteId.make("route-1"),
        }),
        ownsSession: () => Effect.succeed(true),
        replacedAt: Effect.succeed(DbTimestamp.make("2026-08-25T12:00:00.000Z")),
        replaceCurrentSession: () =>
          Effect.sync(() => {
            currentSessionId = replacementSessionId;
            events.push("replace");
          }),
        rollbackCurrentSessionReplacement: () =>
          Effect.sync(() => {
            currentSessionId = deletedSessionId;
            events.push("rollback");
          }),
        settle: () => record(events, "settle"),
      },
    ).pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
    expect(currentSessionId).toBe(deletedSessionId);
    expect(events).toEqual(["recheck", "replace", "recheck", "rollback"]);
  });
});

it.effect("rolls back the replacement when activation fails", () => {
  const events: Array<string> = [];
  const deletedSessionId = SessionId.make("session-1");
  const replacementSessionId = SessionId.make("session-2");
  let currentSessionId = deletedSessionId;

  return Effect.gen(function* () {
    const result = yield* deleteLocalSession(
      { replacementSessionId, sessionId: deletedSessionId },
      {
        activateCurrentSession: record(events, "activate").pipe(
          Effect.andThen(Effect.fail(new TestActivationUnavailable())),
        ),
        authorizeDeletion: () => record(events, "recheck"),
        clearMessages: () => record(events, "clear"),
        inspect: Effect.succeed({
          currentSessionId,
          routeId: ConversationRouteId.make("route-1"),
        }),
        ownsSession: () => Effect.succeed(true),
        replacedAt: Effect.succeed(DbTimestamp.make("2026-08-25T12:00:00.000Z")),
        replaceCurrentSession: () =>
          Effect.sync(() => {
            currentSessionId = replacementSessionId;
            events.push("replace");
          }),
        rollbackCurrentSessionReplacement: () =>
          Effect.sync(() => {
            currentSessionId = deletedSessionId;
            events.push("rollback");
          }),
        settle: () => record(events, "settle"),
      },
    ).pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
    expect(currentSessionId).toBe(deletedSessionId);
    expect(events).toEqual(["recheck", "replace", "recheck", "activate", "rollback"]);
  });
});

it.effect(
  "rolls back and retries a retained current Session deletion after local clear fails",
  () => {
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
          authorizeDeletion: () => record(events, "recheck-retained-authorization"),
          clearMessages: () =>
            Effect.suspend(() => {
              clearAttempts += 1;
              events.push(`clear-${clearAttempts}`);
              return clearAttempts === 1
                ? Effect.fail(new TestLocalClearUnavailable())
                : Effect.void;
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
          rollbackCurrentSessionReplacement: () =>
            Effect.sync(() => {
              currentSessionId = deletedSessionId;
              events.push("rollback");
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
        "recheck-retained-authorization",
        "replace",
        "recheck-retained-authorization",
        "activate",
        "recheck-retained-authorization",
        "clear-1",
        "rollback",
        "recheck-retained-authorization",
        "replace",
        "recheck-retained-authorization",
        "activate",
        "recheck-retained-authorization",
        "clear-2",
        "recheck-retained-authorization",
        "settle",
      ]);
    });
  },
);

it.effect("rolls back the current Session replacement when durable settlement fails", () => {
  const events: Array<string> = [];
  const deletedSessionId = SessionId.make("session-1");
  const replacementSessionId = SessionId.make("session-2");
  let currentSessionId = deletedSessionId;

  return Effect.gen(function* () {
    const result = yield* deleteLocalSession(
      { replacementSessionId, sessionId: deletedSessionId },
      {
        activateCurrentSession: record(events, "activate"),
        authorizeDeletion: () => record(events, "recheck"),
        clearMessages: () => record(events, "clear"),
        inspect: Effect.succeed({
          currentSessionId,
          routeId: ConversationRouteId.make("route-1"),
        }),
        ownsSession: () => Effect.succeed(true),
        replacedAt: Effect.succeed(DbTimestamp.make("2026-08-25T12:00:00.000Z")),
        replaceCurrentSession: () =>
          Effect.sync(() => {
            currentSessionId = replacementSessionId;
            events.push("replace");
          }),
        rollbackCurrentSessionReplacement: () =>
          Effect.sync(() => {
            currentSessionId = deletedSessionId;
            events.push("rollback");
          }),
        settle: () =>
          record(events, "settle").pipe(
            Effect.andThen(Effect.fail(new TestSettlementUnavailable())),
          ),
      },
    ).pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
    expect(currentSessionId).toBe(deletedSessionId);
    expect(events).toEqual([
      "recheck",
      "replace",
      "recheck",
      "activate",
      "recheck",
      "clear",
      "recheck",
      "settle",
      "rollback",
    ]);
  });
});

it.effect("retains Session ownership when authority changes after history clearing", () => {
  const events: Array<string> = [];
  let authorized = true;
  return Effect.gen(function* () {
    const result = yield* deleteLocalSession(
      {
        replacementSessionId: SessionId.make("unused-replacement"),
        sessionId: SessionId.make("session-1"),
      },
      {
        activateCurrentSession: Effect.die(new Error("Historical Session was activated")),
        authorizeDeletion: () =>
          Effect.suspend(() => {
            events.push("recheck");
            return authorized ? Effect.void : Effect.fail(new TestAuthorityChanged());
          }),
        clearMessages: () =>
          Effect.sync(() => {
            events.push("clear");
            authorized = false;
          }),
        inspect: Effect.succeed({
          currentSessionId: SessionId.make("session-2"),
          routeId: ConversationRouteId.make("route-1"),
        }),
        ownsSession: () => Effect.succeed(true),
        replacedAt: Effect.die(new Error("Historical Session requested replacement time")),
        replaceCurrentSession: () => Effect.die(new Error("Historical Session was replaced")),
        rollbackCurrentSessionReplacement: () =>
          Effect.die(new Error("Historical Session replacement was rolled back")),
        settle: () => record(events, "settle"),
      },
    ).pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
    expect(events).toEqual(["recheck", "clear", "recheck"]);
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

class TestActivationUnavailable extends Schema.TaggedError<TestActivationUnavailable>()(
  "TestActivationUnavailable",
  {},
) {}

class TestSettlementUnavailable extends Schema.TaggedError<TestSettlementUnavailable>()(
  "TestSettlementUnavailable",
  {},
) {}
