/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/global-date -- Tests inspect tagged outcomes and fixed immutable event timestamps. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions run inside Effect tests. */
import { expect, it } from "@effect/vitest";
import { IncidentControls } from "../../services/incident-controls";
import { Effect, Schema } from "effect";

import {
  metadata,
  userMessage,
  step,
  occurredAt,
  paid,
  completed,
} from "../../../test/support/conversation-usage-fixture";
import { ThinkRequestId } from "../../domain";
import { CommittedTurnTerminal } from "./committed-turn-terminal";
import {
  conversationUsageEvent,
  decodeConversationUsage,
  retainConversationModelStep,
  settleConversationUsage,
  settleBeforeClearingSession,
  ConversationUsageUnavailable,
  reconcileConversationUsages,
} from "./conversation-usage";

it.effect("combines exact model tokens and provider-rated search once in the original period", () =>
  completed.pipe(
    Effect.map((event) => {
      expect(event.allowancePeriodId).toBe("period-original");
      expect(event.source).toEqual({ sourceId: "submission-1", sourceType: "conversation" });
      expect(event.outcome).toMatchObject({
        _tag: "Completed",
        charge: { ratedCostUsdMicros: 14_092n },
      });
      expect(event.evidenceReferences).toHaveLength(2);
    }),
  ),
);

it.effect("retains unknown model usage without inventing a zero-cache charge", () =>
  Effect.gen(function* () {
    const message = yield* retainConversationModelStep([userMessage], metadata.submissionId, {
      ...step,
      cachedInputTokens: null,
    });
    const failure = yield* conversationUsageEvent(
      [message],
      metadata,
      [{ operationId: "search-1", attempt: paid }],
      occurredAt,
      1,
    ).pipe(Effect.flip);
    expect(failure.message).toContain("unreported");
  }),
);

it.effect("refuses missing steps and conflicting duplicate evidence", () =>
  Effect.gen(function* () {
    const message = yield* retainConversationModelStep([userMessage], metadata.submissionId, {
      ...step,
      stepNumber: 2,
    });
    expect(
      yield* conversationUsageEvent([message], metadata, [], occurredAt, 1).pipe(Effect.flip),
    ).toMatchObject({ _tag: "ConversationUsageUnavailable" });
    const first = yield* retainConversationModelStep([userMessage], metadata.submissionId, step);
    expect(
      yield* retainConversationModelStep([first], metadata.submissionId, {
        ...step,
        outputTokens: 200,
      }).pipe(Effect.flip),
    ).toMatchObject({ _tag: "ConversationUsageUnavailable" });
  }),
);

it.effect(
  "freezes the event before dispatch and replays a lost acknowledgement without rerating",
  () =>
    Effect.gen(function* () {
      const event = yield* completed;
      let terminal = CommittedTurnTerminal.make({
        requestId: ThinkRequestId.make("request-1"),
        submissionId: metadata.submissionId,
        status: "completed",
        usageOccurredAt: occurredAt.toISOString(),
      });
      const ledger = new Map<string, string>();
      let prepareCalls = 0;
      let dispatchCalls = 0;
      const port = {
        read: Effect.sync(() => terminal),
        prepare: () =>
          Effect.sync(() => {
            prepareCalls++;
            return event;
          }),
        retain: (next: CommittedTurnTerminal) =>
          Effect.sync(() => {
            terminal = next;
          }),
        dispatch: () =>
          Effect.gen(function* () {
            dispatchCalls++;
            expect(terminal.usageEventJson).toBeDefined();
            const restored = yield* decodeConversationUsage(terminal.usageEventJson);
            expect(restored).toEqual(event);
            ledger.set(
              restored.source.sourceId,
              String(
                restored.outcome._tag === "Completed"
                  ? restored.outcome.charge.planUsageMicros
                  : 0n,
              ),
            );
            if (dispatchCalls === 1) return yield* Effect.fail("acknowledgement lost");
            return undefined;
          }),
      };
      yield* settleConversationUsage(port).pipe(Effect.flip);
      expect(terminal.usageSettled).toBeUndefined();
      yield* settleConversationUsage({
        ...port,
        prepare: () => Effect.die(new Error("must replay frozen event after rollover")),
      });
      yield* settleConversationUsage(port);
      expect(ledger.size).toBe(1);
      expect(prepareCalls).toBe(1);
      expect(dispatchCalls).toBe(2);
      expect(terminal.usageSettled).toBe(true);
    }),
);

it.effect("does not dispatch failed, aborted, or unmarked historical turns", () =>
  Effect.gen(function* () {
    for (const status of ["error", "aborted", "completed"] as const) {
      yield* settleConversationUsage({
        read: Effect.succeed(
          CommittedTurnTerminal.make({ requestId: ThinkRequestId.make("request-1"), status }),
        ),
        prepare: () => Effect.die(new Error("must not prepare")),
        retain: () => Effect.die(new Error("must not persist")),
        dispatch: () => Effect.die(new Error("must not dispatch")),
      });
    }
  }),
);

it.effect("retains Session history until the frozen ledger event is acknowledged", () =>
  Effect.gen(function* () {
    const event = yield* completed;
    let terminal = CommittedTurnTerminal.make({
      requestId: ThinkRequestId.make("delete-request"),
      status: "completed",
      usageOccurredAt: occurredAt.toISOString(),
    });
    let dispatches = 0;
    let clears = 0;
    const ledger = new Map<string, string>();
    const settle = settleConversationUsage({
      read: Effect.sync(() => terminal),
      prepare: () => Effect.succeed(event),
      retain: (next) =>
        Effect.sync(() => {
          terminal = next;
        }),
      dispatch: (retained) =>
        Effect.gen(function* () {
          dispatches++;
          ledger.set(retained.source.sourceId, retained.allowancePeriodId);
          if (dispatches === 1)
            return yield* new ConversationUsageUnavailable({
              cause: "lost acknowledgement",
              message: "Ledger acknowledgement lost",
            });
          return undefined;
        }),
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(ConversationUsageUnavailable)(cause)
          ? cause
          : new ConversationUsageUnavailable({ cause, message: "invalid frozen event" }),
      ),
    );
    const clear = Effect.sync(() => {
      clears++;
    });
    yield* settleBeforeClearingSession([settle], clear).pipe(Effect.flip);
    expect(clears).toBe(0);
    yield* settleBeforeClearingSession([settle], clear);
    expect(clears).toBe(1);
    expect(ledger.size).toBe(1);
    expect(dispatches).toBe(2);
  }),
);

it.effect("does not permanently block Session deletion on unreported provider usage", () =>
  Effect.gen(function* () {
    const message = yield* retainConversationModelStep([userMessage], metadata.submissionId, {
      ...step,
      cachedInputTokens: null,
    });
    const settlement = conversationUsageEvent([message], metadata, [], occurredAt, 1).pipe(
      Effect.asVoid,
    );
    let cleared = false;
    yield* settleBeforeClearingSession(
      [settlement],
      Effect.sync(() => {
        cleared = true;
      }),
    );
    expect(cleared).toBe(true);
  }),
);

it.effect("continues newer settlements when an older completed turn has unreported evidence", () =>
  Effect.gen(function* () {
    const newer = yield* completed;
    let terminal = CommittedTurnTerminal.make({
      requestId: ThinkRequestId.make("newer-request"),
      status: "completed",
      usageOccurredAt: occurredAt.toISOString(),
    });
    let settled = 0;
    const missing = Effect.fail(
      new ConversationUsageUnavailable({
        cause: "unreported step",
        message: "Older usage is unavailable",
        reason: "unreported",
      }),
    );
    const ready = settleConversationUsage({
      read: Effect.sync(() => terminal),
      prepare: () => Effect.succeed(newer),
      retain: (next) =>
        Effect.sync(() => {
          terminal = next;
        }),
      dispatch: () =>
        Effect.sync(() => {
          settled++;
        }),
    }).pipe(
      Effect.mapError(
        (cause) => new ConversationUsageUnavailable({ cause, message: "Newer settlement failed" }),
      ),
    );
    yield* reconcileConversationUsages([missing, ready]).pipe(Effect.flip);
    expect(settled).toBe(1);
    expect(terminal.usageSettled).toBe(true);
  }),
);

it.effect(
  "retains completed step cost when a later dispatch is refused without charging failed work",
  () =>
    Effect.gen(function* () {
      const retained = yield* retainConversationModelStep(
        [userMessage],
        metadata.submissionId,
        step,
      );
      const controls = IncidentControls.make(() => Effect.succeed(true));
      yield* controls.check("newCostlyWork").pipe(Effect.flip);
      // Refusal never calls retainConversationModelStep, so no second provider step exists.
      expect(retained.metadata).toMatchObject({ osfoConversationModelSteps: [step] });
      const event = yield* conversationUsageEvent([retained], metadata, [], occurredAt, 1);
      expect(event.outcome).toMatchObject({
        _tag: "Completed",
        charge: { ratedCostUsdMicros: 530n },
      });
      let dispatches = 0;
      const failed = CommittedTurnTerminal.make({
        requestId: ThinkRequestId.make("failed-after-pause"),
        status: "error",
        usageOccurredAt: occurredAt.toISOString(),
        usageExpectedModelSteps: 1,
      });
      yield* settleConversationUsage({
        read: Effect.succeed(failed),
        prepare: () => Effect.die(new Error("Failed work retains Company Cost only")),
        retain: () => Effect.die(new Error("Failed work must not freeze User usage")),
        dispatch: () =>
          Effect.sync(() => {
            dispatches += 1;
          }),
      });
      expect(dispatches).toBe(0);
      let terminal = CommittedTurnTerminal.make({
        requestId: ThinkRequestId.make("useful-completed"),
        status: "completed",
        usageOccurredAt: occurredAt.toISOString(),
        usageExpectedModelSteps: 1,
      });
      const settle = settleConversationUsage({
        read: Effect.sync(() => terminal),
        prepare: () => Effect.succeed(event),
        retain: (next) =>
          Effect.sync(() => {
            terminal = next;
          }),
        dispatch: () =>
          Effect.sync(() => {
            dispatches += 1;
          }),
      });
      yield* settle;
      yield* settle;
      expect(dispatches).toBe(1);
      expect(retained.metadata).toMatchObject({ osfoConversationModelSteps: [step] });
    }),
);
