import { Effect, Schema } from "effect";

import { ActionId } from "../../domain/action-execution";
import { ContentId } from "../../domain/client-content";
import { ApprovalPresentation } from "../../services/authorization";
import { ClearCoreMemoryInput, coreMemoryLabelFor } from "./core-memory";
import {
  ActionPresentation,
  ActionPresentationId,
  ActionPresentationUnavailable,
  type PendingThinkAction,
} from "./think-action-approvals";

/** Name registered with Think for retained-document deletion. */
export const documentDeleteActionName = "deleteDocument";

/** Exact retained-document identity shown before deletion Approval. */
export const RetainedDocumentInput = Schema.Struct({ contentId: ContentId });

/** Exact retained-document identity shown before deletion Approval. */
export type RetainedDocumentInput = typeof RetainedDocumentInput.Type;

/** Project one registered Action into its definition-owned immutable presentation. */
export const presentOsfoAction = (
  pending: PendingThinkAction,
): Effect.Effect<ActionPresentation, ActionPresentationUnavailable> => {
  if (pending.descriptor.action === "osfoClearCoreMemory") {
    return presentCoreMemoryClearAction(pending);
  }
  if (pending.descriptor.action === documentDeleteActionName) {
    return presentDocumentDeleteAction(pending);
  }
  return Effect.fail(
    new ActionPresentationUnavailable({
      action: pending.descriptor.action,
      message: "The Action has no safe presentation projection",
    }),
  );
};

const encodeActionPresentation = Schema.encodeSync(ActionPresentation);

/** Canonical identity of the exact structured presentation approved by the User. */
export const approvalPresentationFor = (presentation: ActionPresentation): ApprovalPresentation =>
  ApprovalPresentation.make(JSON.stringify(encodeActionPresentation(presentation)));

/** Verify that the protected effect still targets the exact value shown for Approval. */
export const hasExactActionInput = (
  presentation: ActionPresentation,
  operation: "file.delete" | "memory.clear",
  value: string,
): boolean => {
  const expected =
    operation === "file.delete"
      ? { actionDefinitionVersion: "osfo-delete-generated-document-v1", field: "contentId" }
      : { actionDefinitionVersion: "osfo-core-memory-clear-v1", field: "block" };
  const [field] = presentation.fields;
  return (
    presentation.operation === operation &&
    presentation.actionDefinitionVersion === expected.actionDefinitionVersion &&
    presentation.fields.length === 1 &&
    field?.name === expected.field &&
    field.value === value
  );
};

const presentCoreMemoryClearAction = (
  pending: PendingThinkAction,
): Effect.Effect<ActionPresentation, ActionPresentationUnavailable> =>
  Schema.decodeUnknownEffect(ClearCoreMemoryInput)(pending.descriptor.input).pipe(
    Effect.mapError(
      () =>
        new ActionPresentationUnavailable({
          action: pending.descriptor.action,
          message: "The Core Memory clear input cannot be projected safely",
        }),
    ),
    Effect.map((input) => {
      const label = coreMemoryLabelFor(input.block);
      return ActionPresentation.make({
        actionDefinitionVersion: "osfo-core-memory-clear-v1",
        actionId: ActionId.make(pending.descriptor.toolCallId),
        consequences: [`Permanently clear the ${label} block.`],
        description: `Clear the ${label} block.`,
        fields: [{ label: "Block", name: "block", value: label }],
        operation: "memory.clear",
        presentationId: ActionPresentationId.make(pending.executionId),
        title: `Clear ${label}`,
      });
    }),
  );

const presentDocumentDeleteAction = (
  pending: PendingThinkAction,
): Effect.Effect<ActionPresentation, ActionPresentationUnavailable> =>
  Schema.decodeUnknownEffect(RetainedDocumentInput)(pending.descriptor.input).pipe(
    Effect.mapError(
      () =>
        new ActionPresentationUnavailable({
          action: pending.descriptor.action,
          message: "The retained-document deletion input cannot be projected safely",
        }),
    ),
    Effect.map((input) =>
      ActionPresentation.make({
        actionDefinitionVersion: "osfo-delete-generated-document-v1",
        actionId: ActionId.make(pending.descriptor.toolCallId),
        consequences: ["Permanently delete the retained generated document."],
        description: "Delete the exact retained document shown here.",
        fields: [{ label: "Content", name: "contentId", value: input.contentId }],
        operation: "file.delete",
        presentationId: ActionPresentationId.make(pending.executionId),
        title: "Delete generated document",
      }),
    ),
  );
