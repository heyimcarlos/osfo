import { Schema } from "effect";

import { SessionId } from "../../domain";
import { ActionId } from "../../domain/action-execution";
import { ManagedTurnAuthorityIdentity } from "../../domain/managed-conversation";
import { ApprovalPresentation } from "../../services/authorization";
import { MemoryProvider } from "../../services/memory-provider";
import { CoreMemoryBlockName, type CoreMemoryCorrected } from "./core-memory";

/** Name registered with Think for exact Knowledge Base forgetting. */
export const forgetKnowledgeActionName = "osfoForgetKnowledge";

/** Name registered with Think for complete Session deletion. */
export const sessionDeleteActionName = "osfoDeleteSession";

export const CoreMemoryReplacement = Schema.Struct({
  block: CoreMemoryBlockName,
  content: Schema.String.check(Schema.isMaxLength(10_000)),
});
export type CoreMemoryReplacement = typeof CoreMemoryReplacement.Type;

/** At least one exact local correction that must commit before provider forgetting. */
export const CoreMemoryCorrections = Schema.NonEmptyArray(CoreMemoryReplacement).check(
  Schema.isMaxLength(2),
  Schema.makeFilter(
    (replacements) =>
      new Set(replacements.map(({ block }) => block)).size === replacements.length ||
      "must replace each Core Memory block at most once",
  ),
);

/** Exact approval and originating authority retained beside delayed provider deletion. */
export const DeletionAuthorization = Schema.Struct({
  actionId: ActionId,
  authorityIdentity: ManagedTurnAuthorityIdentity,
  operation: Schema.Literals(["memory.forgetKnowledge", "session.delete"]),
  presentation: ApprovalPresentation,
});
export type DeletionAuthorization = typeof DeletionAuthorization.Type;

/** Exact provider memories and immediate Native Memory corrections to apply together. */
export const ForgetKnowledgeInput = Schema.Struct({
  coreMemory: CoreMemoryCorrections,
  memoryIds: Schema.NonEmptyArray(MemoryProvider.KnowledgeMemoryId),
});

/** Exact provider memories and immediate Native Memory corrections to apply together. */
export type ForgetKnowledgeInput = typeof ForgetKnowledgeInput.Type;

/** Exact Agent-owned Session selected for permanent deletion. */
export const SessionDeleteInput = Schema.Struct({ sessionId: SessionId });

/** Exact Agent-owned Session selected for permanent deletion. */
export type SessionDeleteInput = typeof SessionDeleteInput.Type;

/** Immediate local correction with provider forgetting retained for retry. */
export interface KnowledgeForgetPending {
  readonly _tag: "KnowledgeForgetPending";
  readonly corrected: ReadonlyArray<CoreMemoryCorrected>;
  readonly memoryIds: ForgetKnowledgeInput["memoryIds"];
}

/** Durable local correction ownership retained after cancellation could not be confirmed. */
export interface KnowledgeForgetCorrectionPending {
  readonly _tag: "KnowledgeForgetCorrectionPending";
  readonly memoryIds: ForgetKnowledgeInput["memoryIds"];
}

/** Local Session deletion with provider conversation deletion retained for retry. */
export interface SessionDeletionPending {
  readonly _tag: "SessionDeletionPending";
  readonly sessionId: SessionId;
}

/** Classified failure while applying an exact-approved memory or Session deletion. */
export class DeletionActionUnavailable extends Schema.TaggedError<DeletionActionUnavailable>()(
  "DeletionActionUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals(["forgetKnowledge", "deleteSession"]),
  },
) {}
