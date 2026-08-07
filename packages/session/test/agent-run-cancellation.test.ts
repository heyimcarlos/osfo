import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  applyThreadEvent,
  makeAgentRunCanceled,
  makeAgentRunCancellationRequested,
  makeAssistantOutputAppended,
  makeAssistantOutputInterrupted,
  makeEmptyThreadSnapshot,
  makeUserMessageAppended,
  InvalidThreadProjection,
  type ThreadEvent,
} from "../src/index.js";

const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const agentRunId = "96ae49eb-b1ab-41cb-a468-b68893ec82c3";
const assistantOutputId = "86290831-b9ca-414a-abf1-4055b5347133";
const occurredAt = "2026-08-07T12:00:00.000Z";

const envelope = (event: ThreadEvent) => ({ ...event, cursor: `cursor-${event.threadPosition}` });

describe("AgentRun cancellation session semantics", () => {
  it.effect("folds cancellation through output interruption to one bounded terminal outcome", () =>
    Effect.gen(function* () {
      const input = yield* makeUserMessageAppended({
        eventId: "34dc8a78-a94d-4050-8c5b-e3bf21077c40",
        threadId,
        threadPosition: "1",
        userMessageId: "53146ff7-2205-44b0-8de4-685509112ac9",
        agentRunId,
        occurredAt,
        content: "Cancel this run",
      });
      const output = yield* makeAssistantOutputAppended({
        eventId: "3d21b406-38ba-44f3-bb2b-a204e6dfa1a6",
        threadId,
        threadPosition: "2",
        agentRunId,
        assistantOutputId,
        occurredAt,
        content: "Working",
      });
      const requested = yield* makeAgentRunCancellationRequested({
        eventId: "4a990b08-0ac5-4c79-9d0e-a3fd1ee381d6",
        threadId,
        threadPosition: "3",
        agentRunId,
        occurredAt,
      });
      const interrupted = yield* makeAssistantOutputInterrupted({
        eventId: "56437091-05b3-47e0-a32c-ff1681716f97",
        threadId,
        threadPosition: "4",
        agentRunId,
        assistantOutputId,
        occurredAt,
        cause: "agentRunCanceled",
      });
      expect(interrupted.eventVersion).toBe(2);
      const canceled = yield* makeAgentRunCanceled({
        eventId: "6becadfa-4725-4752-a107-4b7368e5b377",
        threadId,
        threadPosition: "5",
        agentRunId,
        occurredAt,
        cleanupDisposition: { type: "completed" },
        externalWorkMayContinue: false,
      });
      const initial = yield* makeEmptyThreadSnapshot({
        threadId,
        throughCursor: "cursor-origin",
      });
      const cancellationRequested = yield* Effect.reduce(
        [input, output, requested],
        () => initial,
        (state, event) => applyThreadEvent(state, envelope(event)),
      );
      expect(cancellationRequested.activeState).toMatchObject([
        {
          agentRunId,
          phase: { type: "running" },
          cancellation: { type: "requested" },
        },
      ]);

      const snapshot = yield* Effect.reduce(
        [interrupted, canceled],
        () => cancellationRequested,
        (state, event) => applyThreadEvent(state, envelope(event)),
      );

      expect(snapshot.activeState).toEqual([]);
      expect(snapshot.timeline.at(-1)).toMatchObject({
        type: "assistantOutput",
        status: { type: "interrupted", cause: "agentRunCanceled" },
      });
      expect(snapshot.throughPosition).toBe("5");
    }),
  );

  it.effect("rejects duplicate requests and cancellation without a request", () =>
    Effect.gen(function* () {
      const input = yield* makeUserMessageAppended({
        eventId: "34dc8a78-a94d-4050-8c5b-e3bf21077c40",
        threadId,
        threadPosition: "1",
        userMessageId: "53146ff7-2205-44b0-8de4-685509112ac9",
        agentRunId,
        occurredAt,
        content: "Cancel this run",
      });
      const requested = yield* makeAgentRunCancellationRequested({
        eventId: "4a990b08-0ac5-4c79-9d0e-a3fd1ee381d6",
        threadId,
        threadPosition: "2",
        agentRunId,
        occurredAt,
      });
      const duplicate = yield* makeAgentRunCancellationRequested({
        eventId: "e72fcfc6-bd7e-4192-af86-d230e7a805d0",
        threadId,
        threadPosition: "3",
        agentRunId,
        occurredAt,
      });
      const canceled = yield* makeAgentRunCanceled({
        eventId: "6becadfa-4725-4752-a107-4b7368e5b377",
        threadId,
        threadPosition: "2",
        agentRunId,
        occurredAt,
        cleanupDisposition: { type: "completed" },
        externalWorkMayContinue: false,
      });
      const initial = yield* makeEmptyThreadSnapshot({
        threadId,
        throughCursor: "cursor-origin",
      });
      const active = yield* applyThreadEvent(initial, envelope(input));
      const cancellationRequested = yield* applyThreadEvent(active, envelope(requested));

      const duplicateError = yield* Effect.flip(
        applyThreadEvent(cancellationRequested, envelope(duplicate)),
      );
      const unrequestedError = yield* Effect.flip(applyThreadEvent(active, envelope(canceled)));

      expect(duplicateError).toEqual(new InvalidThreadProjection({ reason: "authorityConflict" }));
      expect(unrequestedError).toEqual(
        new InvalidThreadProjection({ reason: "authorityConflict" }),
      );
    }),
  );
});
