import type { ThinkRequestId } from "../../../domain";
import type { AgentSqliteProductEvidence } from "../../../qualification/semantic-evidence";
import type { CommittedTurnReceipt } from "./store";

/** Frozen ingress identity joined to one durable Think committed-turn receipt. */
export interface QualificationCommittedTurnIdentity {
  readonly acceptanceReceiptId: string;
  readonly rootId: string;
  readonly thinkRequestId: ThinkRequestId;
}

/**
 * Adapt durable Agent SQLite rows into qualification evidence.
 * Missing or unreconciled request identities stay absent so the evaluator returns MISSING.
 */
export const committedTurnQualificationEvidence = (
  committedTurns: ReadonlyArray<CommittedTurnReceipt>,
  identities: ReadonlyArray<QualificationCommittedTurnIdentity>,
): ReadonlyArray<AgentSqliteProductEvidence> => {
  const identityByThinkRequest = new Map(
    identities.map((identity) => [identity.thinkRequestId, identity] as const),
  );
  return committedTurns.flatMap((receipt) => {
    if (receipt.thinkRequestId === null) return [];
    const identity = identityByThinkRequest.get(receipt.thinkRequestId);
    if (identity === undefined) return [];
    return [
      {
        acceptanceReceiptId: identity.acceptanceReceiptId,
        authority: "osfo_committed_turns",
        evidenceId: `agent-sqlite:${receipt.observationSequence}:${receipt.assistantMessageId}`,
        occurredAt: `${receipt.observedAt.replace(" ", "T")}Z`,
        productFactId: receipt.assistantMessageId,
        rootId: identity.rootId,
        store: "AgentSQLite",
        thinkRequestId: receipt.thinkRequestId,
      },
    ];
  });
};
