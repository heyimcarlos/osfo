import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  InvalidThreadEvent,
  InvalidThreadProjection,
  ThreadEventEnvelopeSchema,
  applyThreadEvent,
  makeAgentRunSucceeded,
  makeEmptyThreadSnapshot,
  makeToolCallProgressRecorded,
  makeToolCallRequested,
  makeToolCallResultRecorded,
  makeUserMessageAppended,
  type ThreadEvent,
  type ThreadSnapshot,
} from "../src/index.js";

const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const agentRunId = "96ae49eb-b1ab-41cb-a468-b68893ec82c3";
const toolCallId = "tool_86290831-b9ca-414a-abf1-4055b5347133";
const occurredAt = "2026-08-07T12:00:00.000Z";
const presentation = {
  version: 1,
  title: "Search reference documents",
  description: "Find relevant public references for this answer.",
} as const;

const envelope = (event: ThreadEvent) => ({
  ...event,
  cursor: `cursor-${event.threadPosition}`,
});

const input = Effect.runSync(
  makeUserMessageAppended({
    eventId: "34dc8a78-a94d-4050-8c5b-e3bf21077c40",
    threadId,
    threadPosition: "1",
    userMessageId: "e9a31389-50d8-436a-b7be-7303b9fe42d0",
    agentRunId,
    occurredAt,
    content: "Find the reference",
  }),
);

const requested = (threadPosition = "2") =>
  makeToolCallRequested({
    eventId: "f04d3470-bf0c-4b72-90de-0454ac404c9c",
    threadId,
    threadPosition,
    occurredAt,
    agentRunId,
    toolCallId,
    memberIndex: 0,
    presentation,
  });

const progress = (threadPosition: string, message: string) =>
  makeToolCallProgressRecorded({
    eventId:
      threadPosition === "3"
        ? "a4a60d24-7d2e-4808-b6fc-f192ea7631de"
        : "b399f65c-0274-40b4-aa4d-e7b80f8c531c",
    threadId,
    threadPosition,
    occurredAt,
    agentRunId,
    toolCallId,
    presentation,
    progress: { message },
  });

const result = (threadPosition = "5") =>
  makeToolCallResultRecorded({
    eventId: "269787db-071e-4478-806f-1d85d00b7337",
    threadId,
    threadPosition,
    occurredAt,
    agentRunId,
    toolCallId,
    presentation,
    outcome: { type: "succeeded" },
  });

const fold = (snapshot: ThreadSnapshot, events: ReadonlyArray<ThreadEvent>) =>
  Effect.reduce(
    events,
    () => snapshot,
    (state, event) => applyThreadEvent(state, envelope(event)),
  );

describe("non-Action ToolCall client projection", () => {
  it.effect("replaces bounded active progress while canonical events remain immutable", () =>
    Effect.gen(function* () {
      const intent = yield* requested();
      const first = yield* progress("3", "Searching references");
      const second = yield* progress("4", "Reviewing two matches");
      const snapshot = yield* fold(
        yield* makeEmptyThreadSnapshot({ threadId, throughCursor: "origin" }),
        [input, intent, first, second],
      );

      expect(first).toEqual({
        eventId: "a4a60d24-7d2e-4808-b6fc-f192ea7631de",
        eventType: "ToolCallProgressRecorded",
        eventVersion: 1,
        threadId,
        threadPosition: "3",
        occurredAt,
        payload: {
          toolCallId,
          agentRunId,
          presentation,
          progress: { message: "Searching references" },
        },
      });
      expect(snapshot.activeState).toEqual([
        expect.objectContaining({ type: "activeAgentRun", agentRunId }),
        {
          type: "activeToolCall",
          toolCallId,
          agentRunId,
          introducedBy: {
            eventId: intent.eventId,
            position: "2",
            occurredAt,
          },
          memberIndex: 0,
          presentation,
          progress: {
            message: "Reviewing two matches",
            source: {
              eventId: second.eventId,
              position: "4",
              occurredAt,
            },
          },
        },
      ]);
      expect(snapshot.timeline).toHaveLength(1);
      expect(first).toEqual(expect.objectContaining({ payload: expect.any(Object) }));
      expect(first.payload.progress).toEqual({ message: "Searching references" });
    }),
  );

  it.effect("projects one typed terminal outcome without raw arguments or result", () =>
    Effect.gen(function* () {
      const intent = yield* requested();
      const started = yield* progress("3", "Searching references");
      const terminal = yield* result("4");
      const snapshot = yield* fold(
        yield* makeEmptyThreadSnapshot({ threadId, throughCursor: "origin" }),
        [input, intent, started, terminal],
      );

      expect(snapshot.timeline.at(-1)).toEqual({
        type: "toolCallResult",
        toolCallId,
        agentRunId,
        source: {
          firstEventId: terminal.eventId,
          firstPosition: "4",
          firstOccurredAt: occurredAt,
          lastEventId: terminal.eventId,
          lastPosition: "4",
          lastOccurredAt: occurredAt,
        },
        presentation,
        outcome: { type: "succeeded" },
      });
      expect(snapshot.activeState).toEqual([
        expect.objectContaining({ type: "activeAgentRun", agentRunId }),
      ]);
      const encoded = Schema.encodeSync(ThreadEventEnvelopeSchema)({
        ...terminal,
        cursor: "cursor-4",
      });
      expect(JSON.stringify(encoded)).not.toContain("private raw argument");
      expect(JSON.stringify(encoded)).not.toContain("private raw result");
      expect(JSON.stringify(encoded)).not.toContain('"input"');
      expect(JSON.stringify(encoded)).not.toContain('"result"');
    }),
  );

  it.effect("terminalizes a requested ToolCall even when no progress was reported", () =>
    Effect.gen(function* () {
      const intent = yield* requested();
      const terminal = yield* makeToolCallResultRecorded({
        eventId: "269787db-071e-4478-806f-1d85d00b7337",
        threadId,
        threadPosition: "3",
        occurredAt,
        agentRunId,
        toolCallId,
        presentation,
        outcome: { type: "failed", cause: "invalidInput" },
      });
      const snapshot = yield* fold(
        yield* makeEmptyThreadSnapshot({ threadId, throughCursor: "origin" }),
        [input, intent, terminal],
      );

      expect(snapshot.timeline.at(-1)).toEqual(
        expect.objectContaining({
          type: "toolCallResult",
          toolCallId,
          outcome: { type: "failed", cause: "invalidInput" },
        }),
      );
      expect(snapshot.activeState).toEqual([
        expect.objectContaining({ type: "activeAgentRun", agentRunId }),
      ]);
    }),
  );

  it.effect("uses canonical event order for replacement and blocks termination while open", () =>
    Effect.gen(function* () {
      const intent = yield* requested();
      const first = yield* progress("3", "Searching references");
      const repeated = yield* progress("4", "Searching again after a retry");
      const active = yield* fold(
        yield* makeEmptyThreadSnapshot({ threadId, throughCursor: "origin" }),
        [input, intent, first],
      );
      const replaced = yield* applyThreadEvent(active, envelope(repeated));
      expect(
        replaced.activeState.find((state) => state.type === "activeToolCall")?.progress,
      ).toEqual({
        message: "Searching again after a retry",
        source: {
          eventId: repeated.eventId,
          position: "4",
          occurredAt,
        },
      });

      const succeeded = yield* makeAgentRunSucceeded({
        eventId: "269787db-071e-4478-806f-1d85d00b7337",
        threadId,
        threadPosition: "5",
        occurredAt,
        agentRunId,
      });
      const terminalError = yield* Effect.flip(applyThreadEvent(replaced, envelope(succeeded)));
      expect(terminalError).toEqual(new InvalidThreadProjection({ reason: "authorityConflict" }));
    }),
  );

  it.effect("fails closed on conflicting presentation and duplicate terminal results", () =>
    Effect.gen(function* () {
      const intent = yield* requested();
      const first = yield* progress("3", "Searching references");
      const active = yield* fold(
        yield* makeEmptyThreadSnapshot({ threadId, throughCursor: "origin" }),
        [input, intent, first],
      );
      const conflict = yield* makeToolCallProgressRecorded({
        eventId: "a4a60d24-7d2e-4808-b6fc-f192ea7631de",
        threadId,
        threadPosition: "4",
        occurredAt,
        agentRunId,
        toolCallId,
        presentation: { ...presentation, title: "Changed title" },
        progress: { message: "Reviewing" },
      });
      expect(yield* Effect.flip(applyThreadEvent(active, envelope(conflict)))).toEqual(
        new InvalidThreadProjection({ reason: "authorityConflict" }),
      );

      const terminal = yield* result("4");
      const completed = yield* applyThreadEvent(active, envelope(terminal));
      const duplicate = yield* makeToolCallResultRecorded({
        eventId: "b399f65c-0274-40b4-aa4d-e7b80f8c531c",
        threadId,
        threadPosition: "5",
        occurredAt,
        agentRunId,
        toolCallId,
        presentation,
        outcome: { type: "failed", cause: "executionFailed" },
      });
      expect(yield* Effect.flip(applyThreadEvent(completed, envelope(duplicate)))).toEqual(
        new InvalidThreadProjection({ reason: "authorityConflict" }),
      );
    }),
  );

  it.effect("enforces safe text bounds and cannot carry raw input or result fields", () =>
    Effect.gen(function* () {
      const invalid = yield* Effect.flip(
        makeToolCallRequested({
          eventId: "f04d3470-bf0c-4b72-90de-0454ac404c9c",
          threadId,
          threadPosition: "2",
          occurredAt,
          agentRunId,
          toolCallId,
          memberIndex: 0,
          presentation: { ...presentation, title: "x".repeat(513) },
        }),
      );
      expect(invalid).toBeInstanceOf(InvalidThreadEvent);

      const unsafeIntent = {
        eventId: "f04d3470-bf0c-4b72-90de-0454ac404c9c",
        threadId,
        threadPosition: "2",
        occurredAt,
        agentRunId,
        toolCallId,
        memberIndex: 0,
        presentation,
        input: { type: "text", text: "private raw argument" },
      };
      const unsafeTerminal = {
        eventId: "269787db-071e-4478-806f-1d85d00b7337",
        threadId,
        threadPosition: "3",
        occurredAt,
        agentRunId,
        toolCallId,
        presentation,
        outcome: { type: "succeeded" } as const,
        result: { type: "text", text: "private raw result" },
      };
      const safeIntent = yield* makeToolCallRequested(unsafeIntent);
      const safeTerminal = yield* makeToolCallResultRecorded(unsafeTerminal);

      expect(JSON.stringify([safeIntent, safeTerminal])).not.toContain("private raw argument");
      expect(JSON.stringify([safeIntent, safeTerminal])).not.toContain("private raw result");
      expect(JSON.stringify([safeIntent, safeTerminal])).not.toContain('"input"');
      expect(JSON.stringify([safeIntent, safeTerminal])).not.toContain('"result"');
    }),
  );
});
