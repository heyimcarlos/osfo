import { describe, expect, it } from "@effect/vitest";

import { DbTimestamp } from "../../../db";
import { AssistantMessageId, SessionId } from "../../../domain";
import {
  conversationSnapshotOutboxId,
  selectMemoryProviderClaimCandidate,
} from "./memory-provider-outbox";

const now = DbTimestamp.make("2026-08-23T12:00:00.000Z");

describe("MemoryProvider outbox identity", () => {
  it("derives the exact durable retry identity from the committed boundary", () => {
    expect(
      conversationSnapshotOutboxId(
        SessionId.make("session-1"),
        AssistantMessageId.make("assistant-2"),
      ),
    ).toBe("conversation:9:session-1:assistant-2");
  });

  it("keeps opaque Session and message boundaries unambiguous", () => {
    expect(
      conversationSnapshotOutboxId(SessionId.make("a:b"), AssistantMessageId.make("c")),
    ).not.toBe(conversationSnapshotOutboxId(SessionId.make("a"), AssistantMessageId.make("b:c")));
  });
});

describe("MemoryProvider outbox ordering", () => {
  it("blocks a Session behind its live lease while allowing another Session", () => {
    const selected = selectMemoryProviderClaimCandidate(
      [
        candidate("first", "session:one", "claimed", "2026-08-23T12:01:00.000Z"),
        candidate("second", "session:one", "pending", null),
        candidate("other", "session:two", "pending", null),
      ],
      now,
    );

    expect(selected?.outboxId).toBe("other");
  });

  it("recovers an expired claim without advancing past it", () => {
    const selected = selectMemoryProviderClaimCandidate(
      [
        candidate("first", "session:one", "claimed", "2026-08-23T11:59:00.000Z"),
        candidate("second", "session:one", "pending", null),
      ],
      now,
    );

    expect(selected?.outboxId).toBe("first");
  });
});

const candidate = (
  outboxId: string,
  orderingKey: string,
  status: "claimed" | "pending",
  claimExpiresAt: string | null,
) => ({
  availableAt: DbTimestamp.make("2026-08-23T11:00:00.000Z"),
  claimExpiresAt: claimExpiresAt === null ? null : DbTimestamp.make(claimExpiresAt),
  orderingKey,
  outboxId,
  status,
});
