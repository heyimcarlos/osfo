import { AcceptanceReceipt } from "@osfo/api";
import { CommitUnknown } from "@osfo/api/client";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { makeThreadChat, projectCanonicalThreadMessages } from "./atoms";
import { makeThreadProjectionStore } from "./projection-store";
import type { ThreadResumeTransport } from "./resume-thread";
import {
  applyThreadEvent,
  makeEmptyThreadSnapshot,
  makeToolCallProgressRecorded,
  makeToolCallRequested,
  makeToolCallResultRecorded,
  makeUserMessageAppended,
} from "@osfo/session";
import { Deferred, Stream } from "effect";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const idempotencyKey = "1429eaac-2f56-4a7e-b78c-ddd58a9d0f99";

const receipt = new AcceptanceReceipt({
  acceptedAt: "2026-08-06T14:32:00.000Z",
  agentRunId: "f3466bd9-26e6-456e-904c-456198b23a57",
  idempotencyKey,
  protocolVersion: 1,
  receiptId: "10fc5bd9-ca92-46aa-bd36-d305157defd2",
  threadId,
  threadPosition: "1",
  userMessageId: "2aa53c48-fdcf-4131-ab5f-7b04cfa8363e",
});

describe("Thread chat atoms", () => {
  it("projects safe replaceable ToolCall progress and terminal results as canonical messages", () => {
    const toolCallId = "tool_86290831-b9ca-414a-abf1-4055b5347133";
    const presentation = {
      version: 1,
      title: "Search reference documents",
      description: "Find relevant public references for this answer.",
    } as const;
    const events = [
      Effect.runSync(
        makeUserMessageAppended({
          eventId: "34dc8a78-a94d-4050-8c5b-e3bf21077c40",
          threadId,
          threadPosition: "1",
          userMessageId: receipt.userMessageId,
          agentRunId: receipt.agentRunId,
          occurredAt: receipt.acceptedAt,
          content: "Find the reference",
        }),
      ),
      Effect.runSync(
        makeToolCallRequested({
          eventId: "f04d3470-bf0c-4b72-90de-0454ac404c9c",
          threadId,
          threadPosition: "2",
          occurredAt: receipt.acceptedAt,
          agentRunId: receipt.agentRunId,
          toolCallId,
          memberIndex: 0,
          presentation,
        }),
      ),
      Effect.runSync(
        makeToolCallProgressRecorded({
          eventId: "a4a60d24-7d2e-4808-b6fc-f192ea7631de",
          threadId,
          threadPosition: "3",
          occurredAt: receipt.acceptedAt,
          agentRunId: receipt.agentRunId,
          toolCallId,
          presentation,
          progress: { message: "Searching references" },
        }),
      ),
    ];
    const active = events.reduce(
      (state, event, index) =>
        Effect.runSync(
          applyThreadEvent(state, { ...event, cursor: `cursor-position-${index + 1}` }),
        ),
      Effect.runSync(makeEmptyThreadSnapshot({ threadId, throughCursor: "cursor-origin" })),
    );

    expect(projectCanonicalThreadMessages(active).at(-1)).toEqual({
      type: "toolCallProgress",
      messageId: toolCallId,
      toolCallId,
      agentRunId: receipt.agentRunId,
      content: "Search reference documents\nSearching references",
      eventId: "a4a60d24-7d2e-4808-b6fc-f192ea7631de",
      occurredAt: receipt.acceptedAt,
      threadPosition: "3",
      presentation,
      progress: { message: "Searching references" },
    });

    const terminal = Effect.runSync(
      makeToolCallResultRecorded({
        eventId: "269787db-071e-4478-806f-1d85d00b7337",
        threadId,
        threadPosition: "4",
        occurredAt: receipt.acceptedAt,
        agentRunId: receipt.agentRunId,
        toolCallId,
        presentation,
        outcome: { type: "succeeded" },
      }),
    );
    const completed = Effect.runSync(
      applyThreadEvent(active, { ...terminal, cursor: "cursor-position-4" }),
    );
    const projected = projectCanonicalThreadMessages(completed);

    expect(projected.at(-1)).toEqual({
      type: "toolCallResult",
      messageId: toolCallId,
      toolCallId,
      agentRunId: receipt.agentRunId,
      content: "Search reference documents\nOutcome: succeeded",
      eventId: terminal.eventId,
      occurredAt: receipt.acceptedAt,
      threadPosition: "4",
      presentation,
      outcome: { type: "succeeded" },
    });
    expect(JSON.stringify(projected)).not.toContain("private raw argument");
    expect(JSON.stringify(projected)).not.toContain("private raw result");
  });

  it("submits through the API client without treating the receipt as projection authority", () => {
    const commands: Array<unknown> = [];
    const chat = makeThreadChat({
      authenticationToken: "reference-session",
      baseUrl: "https://osfo.test",
      clientInstanceId: "test",
      threadId,
      submitMessage: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return receipt;
        }),
    });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(chat.submit);

    registry.set(chat.submit, { content: "Hello through React", idempotencyKey });

    expect(commands).toEqual([
      {
        authenticationToken: "reference-session",
        baseUrl: "https://osfo.test",
        idempotencyKey,
        message: { content: "Hello through React" },
        threadId,
      },
    ]);
    expect(registry.get(chat.messages)).toEqual([]);
    expect(AsyncResult.isSuccess(registry.get(chat.submit))).toBe(true);

    unmount();
    registry.dispose();
  });

  it("keeps failed submissions out of the accepted transcript", () => {
    const chat = makeThreadChat({
      authenticationToken: "reference-session",
      baseUrl: "https://osfo.test",
      clientInstanceId: "test",
      threadId,
      submitMessage: () => Effect.fail(new CommitUnknown()),
    });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(chat.submit);

    registry.set(chat.submit, { content: "Uncertain message", idempotencyKey });

    expect(registry.get(chat.messages)).toEqual([]);
    expect(AsyncResult.isFailure(registry.get(chat.submit))).toBe(true);

    unmount();
    registry.dispose();
  });

  it("starts canonical bootstrap on mount and interrupts its stream on unmount", async () => {
    const event = Effect.runSync(
      makeUserMessageAppended({
        eventId: "34dc8a78-a94d-4050-8c5b-e3bf21077c40",
        threadId,
        threadPosition: "1",
        userMessageId: receipt.userMessageId,
        agentRunId: receipt.agentRunId,
        occurredAt: receipt.acceptedAt,
        content: "Hello from canonical authority",
      }),
    );
    const snapshot = Effect.runSync(
      applyThreadEvent(
        Effect.runSync(makeEmptyThreadSnapshot({ threadId, throughCursor: "cursor-origin" })),
        { ...event, cursor: "cursor-position-1" },
      ),
    );
    const streamStarted = Effect.runSync(Deferred.make<void>());
    const streamInterrupted = Effect.runSync(Deferred.make<void>());
    const transport: ThreadResumeTransport = {
      snapshot: () => Effect.succeed(snapshot),
      stream: () =>
        Effect.succeed(
          Stream.never.pipe(
            Stream.onStart(Deferred.succeed(streamStarted, undefined)),
            Stream.ensuring(Deferred.succeed(streamInterrupted, undefined)),
          ),
        ),
    };
    const projectionStore = makeThreadProjectionStore({
      storage: new MemoryStorage(),
      threadId,
    });
    const chat = makeThreadChat({
      authenticationToken: "reference-session",
      baseUrl: "https://osfo.test",
      clientInstanceId: "test",
      threadId,
      projectionStore,
      resumeTransport: transport,
      submitMessage: () => Effect.succeed(receipt),
    });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(chat.resume);
    const unmountMessages = registry.mount(chat.messages);
    const unmountSynchronization = registry.mount(chat.synchronization);

    expect(AsyncResult.isWaiting(registry.get(chat.resume))).toBe(true);
    await Effect.runPromise(Deferred.await(streamStarted));

    expect(Effect.runSync(projectionStore.load())).toEqual(snapshot);
    expect(registry.get(chat.synchronization)).toEqual({ type: "synchronizing" });

    expect(registry.get(chat.messages)).toEqual([
      {
        type: "userMessage",
        messageId: receipt.userMessageId,
        agentRunId: receipt.agentRunId,
        content: "Hello from canonical authority",
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        threadPosition: "1",
        userMessageId: receipt.userMessageId,
      },
    ]);

    unmountSynchronization();
    unmountMessages();
    unmount();
    await Effect.runPromise(Deferred.await(streamInterrupted));

    registry.dispose();
  });
});
