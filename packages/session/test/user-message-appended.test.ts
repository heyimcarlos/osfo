import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  InvalidThreadProjection,
  InvalidUserMessageAppended,
  applyThreadEvent,
  makeAgentRunFailed,
  makeAgentRunSucceeded,
  makeAssistantOutputAppended,
  makeAssistantOutputCompleted,
  makeAssistantOutputInterrupted,
  makeEmptyThreadSnapshot,
  makeUserMessageAppended,
} from "../src/index";

const eventInput = {
  eventId: "34dc8a78-a94d-4050-8c5b-e3bf21077c40",
  threadId: "6ef239bd-3f04-4c77-8976-1171e75ea0ab",
  threadPosition: "1",
  userMessageId: "53146ff7-2205-44b0-8de4-685509112ac9",
  agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
  occurredAt: "2026-08-06T12:00:00.000Z",
  content: "Hello, Oz",
};

describe("UserMessageAppended", () => {
  it("constructs the closed canonical event family", () => {
    expect(
      Effect.runSync(
        makeUserMessageAppended({
          ...eventInput,
          threadPosition: "7",
        }),
      ),
    ).toEqual({
      eventId: "34dc8a78-a94d-4050-8c5b-e3bf21077c40",
      eventType: "UserMessageAppended",
      eventVersion: 1,
      threadId: "6ef239bd-3f04-4c77-8976-1171e75ea0ab",
      threadPosition: "7",
      occurredAt: "2026-08-06T12:00:00.000Z",
      payload: {
        userMessageId: "53146ff7-2205-44b0-8de4-685509112ac9",
        agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
        content: [{ type: "text", text: "Hello, Oz" }],
      },
    });
  });

  it.each([
    ["invalid event identity", { eventId: "invalid" }],
    ["invalid ThreadPosition", { threadPosition: "0" }],
    ["invalid timestamp", { occurredAt: "not-a-timestamp" }],
  ])("rejects %s", (_label, change) => {
    const error = Effect.runSync(
      Effect.flip(
        makeUserMessageAppended({
          ...eventInput,
          threadPosition: "7",
          ...change,
        }),
      ),
    );
    expect(error).toBeInstanceOf(InvalidUserMessageAppended);
  });

  it("folds an accepted message into the complete client projection", () => {
    const event = Effect.runSync(makeUserMessageAppended(eventInput));
    const snapshot = Effect.runSync(
      makeEmptyThreadSnapshot({ threadId: eventInput.threadId, throughCursor: "cursor-origin" }),
    );

    expect(
      Effect.runSync(applyThreadEvent(snapshot, { ...event, cursor: "cursor-position-1" })),
    ).toEqual({
      projection: "nativeThread",
      schemaVersion: 2,
      threadId: eventInput.threadId,
      throughPosition: "1",
      throughCursor: "cursor-position-1",
      lastEventId: eventInput.eventId,
      stateRevision: 1,
      replayGuaranteedForMs: 30_000,
      timelineLimit: 100,
      historyBeforePosition: "0",
      timeline: [
        {
          type: "userMessage",
          userMessageId: eventInput.userMessageId,
          agentRunId: eventInput.agentRunId,
          source: {
            firstEventId: eventInput.eventId,
            firstPosition: "1",
            firstOccurredAt: eventInput.occurredAt,
            lastEventId: eventInput.eventId,
            lastPosition: "1",
            lastOccurredAt: eventInput.occurredAt,
          },
          content: [{ type: "text", text: "Hello, Oz" }],
        },
      ],
      activeState: [
        {
          type: "activeAgentRun",
          agentRunId: eventInput.agentRunId,
          introducedBy: {
            eventId: eventInput.eventId,
            position: "1",
            occurredAt: eventInput.occurredAt,
          },
          phase: { type: "pending" },
        },
      ],
    });
  });

  it("folds committed assistant output before the AgentRun terminal outcome", () => {
    const assistantOutputId = "86290831-b9ca-414a-abf1-4055b5347133";
    const events = [
      Effect.runSync(makeUserMessageAppended(eventInput)),
      Effect.runSync(
        makeAssistantOutputAppended({
          ...eventInput,
          eventId: "e9a31389-50d8-436a-b7be-7303b9fe42d0",
          threadPosition: "2",
          assistantOutputId,
          content: "Echo: ",
        }),
      ),
      Effect.runSync(
        makeAssistantOutputAppended({
          ...eventInput,
          eventId: "f04d3470-bf0c-4b72-90de-0454ac404c9c",
          threadPosition: "3",
          assistantOutputId,
          content: "Hello, Oz",
        }),
      ),
      Effect.runSync(
        makeAssistantOutputCompleted({
          ...eventInput,
          eventId: "a4a60d24-7d2e-4808-b6fc-f192ea7631de",
          threadPosition: "4",
          assistantOutputId,
        }),
      ),
      Effect.runSync(
        makeAgentRunSucceeded({
          ...eventInput,
          eventId: "269787db-071e-4478-806f-1d85d00b7337",
          threadPosition: "5",
        }),
      ),
    ];
    const result = events.reduce(
      (snapshot, event, index) =>
        Effect.runSync(
          applyThreadEvent(snapshot, { ...event, cursor: `cursor-position-${index + 1}` }),
        ),
      Effect.runSync(
        makeEmptyThreadSnapshot({ threadId: eventInput.threadId, throughCursor: "origin" }),
      ),
    );

    expect(result.timeline).toEqual([
      expect.objectContaining({
        type: "userMessage",
        userMessageId: eventInput.userMessageId,
      }),
      {
        type: "assistantOutput",
        assistantOutputId,
        agentRunId: eventInput.agentRunId,
        source: {
          firstEventId: "e9a31389-50d8-436a-b7be-7303b9fe42d0",
          firstPosition: "2",
          firstOccurredAt: eventInput.occurredAt,
          lastEventId: "a4a60d24-7d2e-4808-b6fc-f192ea7631de",
          lastPosition: "4",
          lastOccurredAt: eventInput.occurredAt,
        },
        content: [
          { type: "text", text: "Echo: " },
          { type: "text", text: "Hello, Oz" },
        ],
        status: { type: "completed" },
      },
    ]);
    expect(result.activeState).toEqual([]);
    expect(result.throughPosition).toBe("5");
    expect(result.lastEventId).toBe("269787db-071e-4478-806f-1d85d00b7337");
  });

  it("keeps interrupted assistant output distinct from a failed AgentRun", () => {
    const assistantOutputId = "86290831-b9ca-414a-abf1-4055b5347133";
    const events = [
      Effect.runSync(makeUserMessageAppended(eventInput)),
      Effect.runSync(
        makeAssistantOutputAppended({
          ...eventInput,
          eventId: "e9a31389-50d8-436a-b7be-7303b9fe42d0",
          threadPosition: "2",
          assistantOutputId,
          content: "Partial",
        }),
      ),
      Effect.runSync(
        makeAssistantOutputInterrupted({
          ...eventInput,
          eventId: "f04d3470-bf0c-4b72-90de-0454ac404c9c",
          threadPosition: "3",
          assistantOutputId,
          cause: "modelCallFailed",
        }),
      ),
      Effect.runSync(
        makeAgentRunFailed({
          ...eventInput,
          eventId: "a4a60d24-7d2e-4808-b6fc-f192ea7631de",
          threadPosition: "4",
          cause: "modelCallFailed",
        }),
      ),
    ];
    const result = events.reduce(
      (snapshot, event, index) =>
        Effect.runSync(
          applyThreadEvent(snapshot, { ...event, cursor: `cursor-position-${index + 1}` }),
        ),
      Effect.runSync(
        makeEmptyThreadSnapshot({ threadId: eventInput.threadId, throughCursor: "origin" }),
      ),
    );

    expect(result.timeline[1]).toMatchObject({
      type: "assistantOutput",
      status: { type: "interrupted", cause: "modelCallFailed" },
    });
    expect(result.activeState).toEqual([]);
  });

  it("projects an AssistantOutput interrupted before its first fragment", () => {
    const assistantOutputId = "86290831-b9ca-414a-abf1-4055b5347133";
    const events = [
      Effect.runSync(makeUserMessageAppended(eventInput)),
      Effect.runSync(
        makeAssistantOutputInterrupted({
          ...eventInput,
          eventId: "f04d3470-bf0c-4b72-90de-0454ac404c9c",
          threadPosition: "2",
          assistantOutputId,
          cause: "modelCallFailed",
        }),
      ),
      Effect.runSync(
        makeAgentRunFailed({
          ...eventInput,
          eventId: "a4a60d24-7d2e-4808-b6fc-f192ea7631de",
          threadPosition: "3",
          cause: "modelCallFailed",
        }),
      ),
    ];
    const result = events.reduce(
      (snapshot, event, index) =>
        Effect.runSync(
          applyThreadEvent(snapshot, { ...event, cursor: `cursor-position-${index + 1}` }),
        ),
      Effect.runSync(
        makeEmptyThreadSnapshot({ threadId: eventInput.threadId, throughCursor: "origin" }),
      ),
    );

    expect(result.timeline[1]).toMatchObject({
      type: "assistantOutput",
      assistantOutputId,
      content: [],
      status: { type: "interrupted", cause: "modelCallFailed" },
    });
    expect(result.activeState).toEqual([]);
  });

  it("ignores an identical duplicate without advancing projection state", () => {
    const event = Effect.runSync(makeUserMessageAppended(eventInput));
    const snapshot = Effect.runSync(
      applyThreadEvent(
        Effect.runSync(
          makeEmptyThreadSnapshot({ threadId: eventInput.threadId, throughCursor: "origin" }),
        ),
        { ...event, cursor: "cursor-position-1" },
      ),
    );

    expect(
      Effect.runSync(applyThreadEvent(snapshot, { ...event, cursor: "fresh-duplicate-cursor" })),
    ).toBe(snapshot);
  });

  it("ignores an older duplicate after later events have advanced the cursor", () => {
    const first = Effect.runSync(makeUserMessageAppended(eventInput));
    const second = Effect.runSync(
      makeUserMessageAppended({
        ...eventInput,
        eventId: "0a2415a9-dccd-4dd6-8dd2-29ad6278cd6f",
        threadPosition: "2",
        userMessageId: "e64674df-0de1-4cf5-9bbf-27563e5bd27a",
        agentRunId: "71c5311f-9b88-480e-a6b3-f572c868a9a1",
      }),
    );
    const snapshot = Effect.runSync(
      applyThreadEvent(
        Effect.runSync(
          applyThreadEvent(
            Effect.runSync(
              makeEmptyThreadSnapshot({
                threadId: eventInput.threadId,
                throughCursor: "origin",
              }),
            ),
            { ...first, cursor: "cursor-position-1" },
          ),
        ),
        { ...second, cursor: "cursor-position-2" },
      ),
    );

    expect(
      Effect.runSync(applyThreadEvent(snapshot, { ...first, cursor: "cursor-position-1" })),
    ).toBe(snapshot);
  });

  it("fails closed when replay contains a gap", () => {
    const event = Effect.runSync(makeUserMessageAppended({ ...eventInput, threadPosition: "2" }));
    const snapshot = Effect.runSync(
      makeEmptyThreadSnapshot({ threadId: eventInput.threadId, throughCursor: "origin" }),
    );

    const error = Effect.runSync(
      Effect.flip(applyThreadEvent(snapshot, { ...event, cursor: "cursor-position-2" })),
    );

    expect(error).toEqual(new InvalidThreadProjection({ reason: "gap" }));
  });

  it("keeps the live timeline within the snapshot bound", () => {
    const snapshot = Effect.runSync(
      makeEmptyThreadSnapshot({
        threadId: eventInput.threadId,
        throughCursor: "origin",
        timelineLimit: 2,
      }),
    );
    const inputs = [
      eventInput,
      {
        ...eventInput,
        eventId: "0a2415a9-dccd-4dd6-8dd2-29ad6278cd6f",
        threadPosition: "2",
        userMessageId: "e64674df-0de1-4cf5-9bbf-27563e5bd27a",
        agentRunId: "71c5311f-9b88-480e-a6b3-f572c868a9a1",
      },
      {
        ...eventInput,
        eventId: "1970fe0f-dcb6-43df-aa2c-0ae41a9e1b07",
        threadPosition: "3",
        userMessageId: "f09f73bf-420f-414a-8e6a-c5741d43c729",
        agentRunId: "8348b413-dc22-414f-8486-88a6d9a9bfd5",
      },
    ];
    const result = inputs.reduce(
      (current, input) =>
        Effect.runSync(
          applyThreadEvent(current, {
            ...Effect.runSync(makeUserMessageAppended(input)),
            cursor: `cursor-position-${input.threadPosition}`,
          }),
        ),
      snapshot,
    );

    expect(result.timeline.map((item) => item.source.firstPosition)).toEqual(["2", "3"]);
    expect(result.historyBeforePosition).toBe("1");
  });
});
