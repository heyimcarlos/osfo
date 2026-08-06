import { describe, expect, it } from "@effect/vitest";
import {
  applyThreadEvent,
  makeEmptyThreadSnapshot,
  makeUserMessageAppended,
  type ThreadEventEnvelope,
} from "@osfo/session";
import { Effect } from "effect";
import { makeThreadProjectionStore, ProjectionStoreUnavailable } from "./projection-store";

const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const snapshot = Effect.runSync(
  makeEmptyThreadSnapshot({ threadId, throughCursor: "cursor-origin" }),
);
const event: ThreadEventEnvelope = {
  ...Effect.runSync(
    makeUserMessageAppended({
      eventId: "34dc8a78-a94d-4050-8c5b-e3bf21077c40",
      threadId,
      threadPosition: "1",
      userMessageId: "53146ff7-2205-44b0-8de4-685509112ac9",
      agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
      occurredAt: "2026-08-06T12:00:00.000Z",
      content: "Hello, Oz",
    }),
  ),
  cursor: "cursor-position-1",
};

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  failNextWrite = false;

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
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new DOMException("Storage failed", "QuotaExceededError");
    }
    this.values.set(key, value);
  }
}

describe("per-tab Thread projection store", () => {
  it("persists the complete snapshot and cursor in one record across reload", () => {
    const storage = new MemoryStorage();
    const first = makeThreadProjectionStore({ storage, threadId });
    Effect.runSync(first.replace(snapshot));

    const reloaded = makeThreadProjectionStore({ storage, threadId });
    expect(Effect.runSync(reloaded.load())).toEqual(snapshot);
    expect(storage.length).toBe(1);
  });

  it("does not advance either projection or cursor when an atomic write fails", () => {
    const storage = new MemoryStorage();
    const store = makeThreadProjectionStore({ storage, threadId });
    Effect.runSync(store.replace(snapshot));
    storage.failNextWrite = true;

    const error = Effect.runSync(Effect.flip(store.apply(event)));

    expect(error).toBeInstanceOf(ProjectionStoreUnavailable);
    expect(Effect.runSync(store.load())).toEqual(snapshot);
  });

  it("preserves the last applied state when replay contains a gap", () => {
    const storage = new MemoryStorage();
    const store = makeThreadProjectionStore({ storage, threadId });
    Effect.runSync(store.replace(snapshot));
    const gap = { ...event, threadPosition: "2", cursor: "cursor-position-2" };

    expect(() => Effect.runSync(store.apply(gap))).toThrow();
    expect(Effect.runSync(store.load())).toEqual(snapshot);
  });

  it("keeps two tabs independent even when one advances", () => {
    const tabA = makeThreadProjectionStore({ storage: new MemoryStorage(), threadId });
    const tabB = makeThreadProjectionStore({ storage: new MemoryStorage(), threadId });
    Effect.runSync(tabA.replace(snapshot));
    Effect.runSync(tabB.replace(snapshot));
    const advanced = Effect.runSync(applyThreadEvent(snapshot, event));

    Effect.runSync(tabA.apply(event));

    expect(Effect.runSync(tabA.load())).toEqual(advanced);
    expect(Effect.runSync(tabB.load())).toEqual(snapshot);
  });
});
