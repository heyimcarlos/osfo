import { action, type PendingApproval } from "@cloudflare/think";
import { Option, Schema } from "effect";

import { ActionId } from "../../domain/action-execution";
import type { Denied } from "../../services/authorization";
import {
  artifactDeleteActionName,
  documentDeleteActionName,
  researchReportStartActionName,
  ResearchReportStartInput,
  RetainedDocumentInput,
} from "./action-presentation";
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
import { personalSkillDeleteActionName, SkillDeleteInput } from "./personal-skill-tools";
import type { PersonalSkillId } from "../../domain/personal-skill";
import type { ResearchReport } from "../../services/research-report";
import {
  CalendarCreateEventInput,
  CalendarDeleteEventInput,
  CalendarUpdateEventInput,
  DriveDeliverArtifactInput,
  GmailMessageInput,
} from "../../domain/integration-manifest";

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
  | Partial<ResearchReport.Request>
  | Partial<typeof CalendarCreateEventInput.Type>
  | Partial<typeof CalendarDeleteEventInput.Type>
  | Partial<typeof CalendarUpdateEventInput.Type>
  | Partial<typeof DriveDeliverArtifactInput.Type>
  | Partial<typeof GmailMessageInput.Type>
  | Partial<SkillDeleteInput>
  | Partial<SessionDeleteInput>;

export {
  artifactDeleteActionName,
  documentDeleteActionName,
  presentOsfoAction,
  researchReportStartActionName,
  ResearchReportIdentityInput,
  researchReportRequiresApproval,
  ResearchReportStartInput,
  RetainedDocumentInput,
} from "./action-presentation";

export {
  documentBuildStartActionName,
  DocumentBuildIdentityInput,
  DocumentBuildStartInput,
} from "./action-presentation";

/** Name registered with Think for the Core Memory clear Action. */
export const coreMemoryClearActionName = "osfoClearCoreMemory";
/** Name registered with Think for approval-gated personal Skill deletion. */
export { personalSkillDeleteActionName } from "./personal-skill-tools";

/** Closed result returned by the Approval-gated personal Skill deletion Action. */
export type PersonalSkillDeleteActionResult =
  | Denied
  | { readonly _tag: "Deleted"; readonly skillId: PersonalSkillId }
  | { readonly _tag: "SkillUnavailable"; readonly message: string };

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
  readonly deletePersonalSkill: (
    input: SkillDeleteInput,
    actionId: ActionId,
  ) => Promise<PersonalSkillDeleteActionResult>;
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
    [personalSkillDeleteActionName]: action({
      approval: true,
      approvalRisk: "high",
      approvalSummary: "Delete one personal Skill",
      description: "Permanently delete one exact personal Skill lineage after Approval.",
      execute: (input, context) =>
        options.deletePersonalSkill(input, ActionId.make(context.toolCallId)),
      idempotencyKey: ({ ctx }) => `personal-skill-delete:${ctx.toolCallId}`,
      inputSchema: effectToolSchema(SkillDeleteInput),
      kind: "durable-pause",
      permissions: ["skills:delete"],
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
  if (approval.descriptor.action === artifactDeleteActionName) {
    return withInput(
      approval,
      Schema.decodeUnknownOption(RetainedDocumentInput)(approval.descriptor.input).pipe(
        Option.match({ onNone: () => ({}), onSome: (safe) => safe }),
      ),
    );
  }
  if (approval.descriptor.action === researchReportStartActionName) {
    return withInput(
      approval,
      Schema.decodeUnknownOption(ResearchReportStartInput)(approval.descriptor.input).pipe(
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
  if (approval.descriptor.action === personalSkillDeleteActionName) {
    return withInput(
      approval,
      Schema.decodeUnknownOption(SkillDeleteInput)(approval.descriptor.input).pipe(
        Option.match({ onNone: () => ({}), onSome: (safe) => safe }),
      ),
    );
  }
  if (approval.descriptor.action === "calendarUpdateEvent") {
    return withInput(
      approval,
      Schema.decodeUnknownOption(CalendarUpdateEventInput)(approval.descriptor.input).pipe(
        Option.match({ onNone: () => ({}), onSome: (safe) => safe }),
      ),
    );
  }
  if (approval.descriptor.action === "calendarCreateEvent") {
    return withInput(
      approval,
      Schema.decodeUnknownOption(CalendarCreateEventInput)(approval.descriptor.input).pipe(
        Option.match({ onNone: () => ({}), onSome: (safe) => safe }),
      ),
    );
  }
  if (approval.descriptor.action === "calendarDeleteEvent") {
    return withInput(
      approval,
      Schema.decodeUnknownOption(CalendarDeleteEventInput)(approval.descriptor.input).pipe(
        Option.match({ onNone: () => ({}), onSome: (safe) => safe }),
      ),
    );
  }
  if (approval.descriptor.action === "driveDeliverArtifact") {
    return withInput(
      approval,
      Schema.decodeUnknownOption(DriveDeliverArtifactInput)(approval.descriptor.input).pipe(
        Option.match({ onNone: () => ({}), onSome: (safe) => safe }),
      ),
    );
  }
  if (approval.descriptor.action === "gmailSendEmail") {
    return withInput(
      approval,
      Schema.decodeUnknownOption(GmailMessageInput)(approval.descriptor.input).pipe(
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
