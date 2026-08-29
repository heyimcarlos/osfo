import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { ThinkRequestId } from "../../../domain";
import { CommittedTurnReceipt } from "./store";
import { committedTurnQualificationEvidence } from "./qualification-evidence";

describe("committed-turn qualification evidence", () => {
  it("adapts only frozen request identities from the durable committed-turn row", () => {
    const requestId = Schema.decodeSync(ThinkRequestId)("request-1");
    const committed = Schema.decodeSync(CommittedTurnReceipt)({
      assistantMessageId: "assistant-1",
      observationSequence: 7,
      observedAt: "2026-08-17 12:00:00",
      sessionId: "session-1",
      source: "hook",
      thinkRequestId: requestId,
    });
    const unreconciled = Schema.decodeSync(CommittedTurnReceipt)({
      assistantMessageId: "assistant-2",
      observationSequence: 8,
      observedAt: "2026-08-17 12:00:01",
      sessionId: "session-1",
      source: "reconciliation",
      thinkRequestId: null,
    });

    expect(
      committedTurnQualificationEvidence(
        [committed, unreconciled],
        [{ acceptanceReceiptId: "receipt-1", rootId: "root-1", thinkRequestId: requestId }],
      ),
    ).toEqual([
      {
        acceptanceReceiptId: "receipt-1",
        authority: "osfo_committed_turns",
        evidenceId: "agent-sqlite:7:assistant-1",
        occurredAt: "2026-08-17T12:00:00Z",
        productFactId: "assistant-1",
        rootId: "root-1",
        store: "AgentSQLite",
        thinkRequestId: "request-1",
      },
    ]);
  });
});
