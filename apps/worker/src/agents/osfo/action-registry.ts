import { action, type PendingApproval } from "@cloudflare/think";
import { Option, Schema } from "effect";

import { ActionId } from "../../domain/action-execution";
import type { Denied } from "../../services/authorization";
import { documentDeleteActionName, RetainedDocumentInput } from "./action-presentation";
import {
  ClearCoreMemoryInput,
  type CoreMemoryCleared,
  type CoreMemoryUnavailable,
} from "./core-memory";
import {
  type DeletionActionUnavailable,
  ForgetKnowledgeInput,
  forgetKnowledgeActionName,
  type KnowledgeForgetPending,
  type KnowledgeForgetCorrectionPending,
  SessionDeleteInput,
  type SessionDeletionPending,
  sessionDeleteActionName,
} from "./deletion-actions";

export {
  ForgetKnowledgeInput,
  forgetKnowledgeActionName,
  SessionDeleteInput,
  sessionDeleteActionName,
} from "./deletion-actions";
import { effectToolSchema } from "./effect-tool-schema";

type SanitizedPendingApprovalInput =
  | Partial<ClearCoreMemoryInput>
  | Partial<ForgetKnowledgeInput>
  | Partial<RetainedDocumentInput>
  | Partial<SessionDeleteInput>;

export {
  documentDeleteActionName,
  presentOsfoAction,
  RetainedDocumentInput,
} from "./action-presentation";

/** Name registered with Think for the Core Memory clear Action. */
export const coreMemoryClearActionName = "osfoClearCoreMemory";

/** Build Osfo's cohesive Think Action registry. */
export const makeOsfoActions = (options: {
  readonly clearCoreMemory: (
    input: ClearCoreMemoryInput,
    actionId: ActionId,
  ) => Promise<CoreMemoryCleared | CoreMemoryUnavailable | Denied>;
  readonly deleteSession: (
    input: SessionDeleteInput,
    actionId: ActionId,
  ) => Promise<DeletionActionUnavailable | Denied | SessionDeletionPending>;
  readonly forgetKnowledge: (
    input: ForgetKnowledgeInput,
    actionId: ActionId,
  ) => Promise<
    DeletionActionUnavailable | Denied | KnowledgeForgetCorrectionPending | KnowledgeForgetPending
  >;
}) => {
  const actions = {
    [coreMemoryClearActionName]: action({
      approval: true,
      approvalRisk: "high",
      approvalSummary: "Clear the selected Core Memory block",
      description: "Clear one selected Core Memory block after exact human Approval.",
      // oxlint-disable-next-line effecttsgo/async-function -- Think Actions require a Promise-returning execute callback.
      execute: async (input, context) =>
        await options.clearCoreMemory(input, ActionId.make(context.toolCallId)),
      idempotencyKey: ({ ctx }) => `core-memory-clear:${ctx.toolCallId}`,
      inputSchema: effectToolSchema(ClearCoreMemoryInput),
      kind: "durable-pause",
      permissions: ["memory:clear"],
    }),
    [forgetKnowledgeActionName]: action({
      approval: true,
      approvalRisk: "high",
      approvalSummary: "Forget selected knowledge",
      description:
        "Correct matching Core Memory immediately and permanently forget the selected derived knowledge while preserving Session transcripts.",
      // oxlint-disable-next-line effecttsgo/async-function -- Think Actions require a Promise-returning execute callback.
      execute: async (input, context) =>
        await options.forgetKnowledge(input, ActionId.make(context.toolCallId)),
      idempotencyKey: ({ ctx }) => `knowledge-forget:${ctx.toolCallId}`,
      inputSchema: effectToolSchema(ForgetKnowledgeInput),
      kind: "durable-pause",
      permissions: ["memory:delete"],
    }),
    [sessionDeleteActionName]: action({
      approval: true,
      approvalRisk: "high",
      approvalSummary: "Delete one Session",
      description:
        "Permanently delete one Agent-owned Session locally and from the Knowledge Base.",
      // oxlint-disable-next-line effecttsgo/async-function -- Think Actions require a Promise-returning execute callback.
      execute: async (input, context) =>
        await options.deleteSession(input, ActionId.make(context.toolCallId)),
      idempotencyKey: ({ ctx }) => `session-delete:${ctx.toolCallId}`,
      inputSchema: effectToolSchema(SessionDeleteInput),
      kind: "durable-pause",
      permissions: ["sessions:delete"],
    }),
  };
  return actions;
};

/** Keep only definition-owned input fields on every pending Approval. */
export const sanitizePendingApproval = (approval: PendingApproval): PendingApproval => {
  if (approval.source !== "action") return withoutInput(approval);
  if (approval.descriptor.action === coreMemoryClearActionName) {
    return withInput(
      approval,
      Schema.decodeUnknownOption(ClearCoreMemoryInput)(approval.descriptor.input).pipe(
        Option.match({ onNone: () => ({}), onSome: (safe) => safe }),
      ),
    );
  }
  if (approval.descriptor.action === documentDeleteActionName) {
    return withInput(
      approval,
      Schema.decodeUnknownOption(RetainedDocumentInput)(approval.descriptor.input).pipe(
        Option.match({ onNone: () => ({}), onSome: (safe) => safe }),
      ),
    );
  }
  if (approval.descriptor.action === forgetKnowledgeActionName) {
    return withInput(
      approval,
      Schema.decodeUnknownOption(ForgetKnowledgeInput)(approval.descriptor.input).pipe(
        Option.match({ onNone: () => ({}), onSome: (safe) => safe }),
      ),
    );
  }
  if (approval.descriptor.action === sessionDeleteActionName) {
    return withInput(
      approval,
      Schema.decodeUnknownOption(SessionDeleteInput)(approval.descriptor.input).pipe(
        Option.match({ onNone: () => ({}), onSome: (safe) => safe }),
      ),
    );
  }
  return withoutInput(approval);
};

const withInput = (
  approval: PendingApproval,
  input: SanitizedPendingApprovalInput,
): PendingApproval =>
  Object.assign({}, approval, {
    descriptor: Object.assign({}, approval.descriptor, { input }),
  });

const withoutInput = (approval: PendingApproval): PendingApproval => withInput(approval, {});
