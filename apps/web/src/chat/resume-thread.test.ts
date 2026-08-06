import { CursorOutsideRetention, ThreadResumeUnavailable } from "@osfo/api";
import { describe, expect, it } from "@effect/vitest";
import {
  applyThreadEvent,
  makeEmptyThreadSnapshot,
  makeUserMessageAppended,
  type ThreadEventEnvelope,
} from "@osfo/session";
import { Effect, Stream } from "effect";
import { makeThreadProjectionStore } from "./projection-store";
import { synchronizeThreadOnce, type ThreadResumeTransport } from "./resume-thread";

const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";

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

const makeEvent = (position: 1 | 2, content: string): ThreadEventEnvelope => ({
  ...Effect.runSync(
    makeUserMessageAppended({
      eventId:
        position === 1
          ? "34dc8a78-a94d-4050-8c5b-e3bf21077c40"
          : "0a2415a9-dccd-4dd6-8dd2-29ad6278cd6f",
      threadId,
      threadPosition: String(position),
      userMessageId:
        position === 1
          ? "53146ff7-2205-44b0-8de4-685509112ac9"
          : "e64674df-0de1-4cf5-9bbf-27563e5bd27a",
      agentRunId:
        position === 1
          ? "96ae49eb-b1ab-41cb-a468-b68893ec82c3"
          : "71c5311f-9b88-480e-a6b3-f572c868a9a1",
      occurredAt: `2026-08-06T12:00:0${position}.000Z`,
      content,
    }),
  ),
  cursor: `cursor-position-${position}`,
});

const event1 = makeEvent(1, "First");
const event2 = makeEvent(2, "Second");
const empty = Effect.runSync(makeEmptyThreadSnapshot({ threadId, throughCursor: "cursor-origin" }));
const through1 = Effect.runSync(applyThreadEvent(empty, event1));
const through2 = Effect.runSync(applyThreadEvent(through1, event2));

describe("Thread resume coordinator", () => {
  it("bootstraps a lost local projection then applies replay crash-consistently", async () => {
    const store = makeThreadProjectionStore({ storage: new MemoryStorage(), threadId });
    const observed: Array<string> = [];
    const transport: ThreadResumeTransport = {
      snapshot: () => Effect.succeed(through1),
      stream: (cursor) => {
        observed.push(cursor);
        return Effect.succeed(
          Stream.make(
            { event: "thread_event" as const, data: event2 },
            {
              event: "caught_up" as const,
              data: { throughPosition: "2", throughCursor: event2.cursor },
            },
          ),
        );
      },
    };

    await Effect.runPromise(synchronizeThreadOnce({ store, transport }));

    expect(observed).toEqual([event1.cursor]);
    expect(Effect.runSync(store.load())).toEqual(through2);
  });

  it("reloads from its own persisted cursor without replacing valid local state", async () => {
    const store = makeThreadProjectionStore({ storage: new MemoryStorage(), threadId });
    Effect.runSync(store.replace(through1));
    let snapshotCalls = 0;
    const transport: ThreadResumeTransport = {
      snapshot: () => {
        snapshotCalls += 1;
        return Effect.succeed(through2);
      },
      stream: (cursor) => {
        expect(cursor).toBe(event1.cursor);
        return Effect.succeed(Stream.empty);
      },
    };

    await Effect.runPromise(synchronizeThreadOnce({ store, transport }));

    expect(snapshotCalls).toBe(0);
    expect(Effect.runSync(store.load())).toEqual(through1);
  });

  it("atomically replaces state when the persisted cursor is outside retention", async () => {
    const store = makeThreadProjectionStore({ storage: new MemoryStorage(), threadId });
    Effect.runSync(store.replace(empty));
    const cursors: Array<string> = [];
    const transport: ThreadResumeTransport = {
      snapshot: () => Effect.succeed(through2),
      stream: (cursor) => {
        cursors.push(cursor);
        return cursor === empty.throughCursor
          ? Effect.fail(new CursorOutsideRetention())
          : Effect.succeed(Stream.empty);
      },
    };

    await Effect.runPromise(synchronizeThreadOnce({ store, transport }));

    expect(cursors).toEqual([empty.throughCursor, through2.throughCursor]);
    expect(Effect.runSync(store.load())).toEqual(through2);
  });

  it("preserves the last fully applied event when the connection fails", async () => {
    const store = makeThreadProjectionStore({ storage: new MemoryStorage(), threadId });
    Effect.runSync(store.replace(through1));
    const transport: ThreadResumeTransport = {
      snapshot: () => Effect.succeed(through1),
      stream: () =>
        Effect.succeed(
          Stream.make({ event: "thread_event" as const, data: event2 }).pipe(
            Stream.concat(Stream.fail(new ThreadResumeUnavailable())),
          ),
        ),
    };

    await expect(
      Effect.runPromise(synchronizeThreadOnce({ store, transport })),
    ).rejects.toBeDefined();
    expect(Effect.runSync(store.load())).toEqual(through2);
  });

  it("replaces the preserved projection from authority after a replay gap", async () => {
    const store = makeThreadProjectionStore({ storage: new MemoryStorage(), threadId });
    Effect.runSync(store.replace(through1));
    const gap = { ...event2, threadPosition: "3", cursor: "cursor-position-3" };
    let snapshotCalls = 0;
    const transport: ThreadResumeTransport = {
      snapshot: () => {
        snapshotCalls += 1;
        return Effect.succeed(through2);
      },
      stream: () => Effect.succeed(Stream.make({ event: "thread_event" as const, data: gap })),
    };

    await Effect.runPromise(synchronizeThreadOnce({ store, transport }));

    expect(snapshotCalls).toBe(1);
    expect(Effect.runSync(store.load())).toEqual(through2);
  });
});
