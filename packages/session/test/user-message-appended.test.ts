import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { InvalidUserMessageAppended, makeUserMessageAppended } from "../src/index";

describe("UserMessageAppended", () => {
  it("constructs the closed canonical event family", () => {
    expect(
      Effect.runSync(
        makeUserMessageAppended({
          eventId: "34dc8a78-a94d-4050-8c5b-e3bf21077c40",
          threadId: "6ef239bd-3f04-4c77-8976-1171e75ea0ab",
          threadPosition: "7",
          userMessageId: "53146ff7-2205-44b0-8de4-685509112ac9",
          agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
          occurredAt: "2026-08-06T12:00:00.000Z",
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
          eventId: "34dc8a78-a94d-4050-8c5b-e3bf21077c40",
          threadId: "6ef239bd-3f04-4c77-8976-1171e75ea0ab",
          threadPosition: "7",
          userMessageId: "53146ff7-2205-44b0-8de4-685509112ac9",
          agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
          occurredAt: "2026-08-06T12:00:00.000Z",
          ...change,
        }),
      ),
    );
    expect(error).toBeInstanceOf(InvalidUserMessageAppended);
  });
});
