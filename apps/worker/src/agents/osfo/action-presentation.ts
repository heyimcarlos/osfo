import { Effect, Schema } from "effect";

import { ActionId } from "../../domain/action-execution";
import { ContentId } from "../../domain/client-content";
import type { ActionPresentationPersistence } from "../../services/action-approvals";
import { ApprovalPresentation } from "../../services/authorization";
import { ClearCoreMemoryInput, coreMemoryLabelFor } from "./core-memory";
import {
  ActionPresentation,
  ActionPresentationId,
  ActionPresentationUnavailable,
  ThinkApprovalUnavailable,
  type PendingThinkAction,
} from "./think-action-approvals";

/** Name registered with Think for retained-document deletion. */
export const documentDeleteActionName = "deleteDocument";

/** Exact retained-document identity shown before deletion Approval. */
export const RetainedDocumentInput = Schema.Struct({ contentId: ContentId });

/** Exact retained-document identity shown before deletion Approval. */
export type RetainedDocumentInput = typeof RetainedDocumentInput.Type;

/** Project one registered Action into its definition-owned immutable presentation. */
export const presentOsfoAction = Effect.fn("ActionPresentation.present")(function* (
  pending: PendingThinkAction,
) {
  if (pending.descriptor.action === "osfoClearCoreMemory") {
    return yield* presentCoreMemoryClearAction(pending);
  }
  if (pending.descriptor.action === documentDeleteActionName) {
    return yield* presentDocumentDeleteAction(pending);
  }
  return yield* new ActionPresentationUnavailable({
    action: pending.descriptor.action,
    message: "The Action has no safe presentation projection",
  });
});

const encodeActionPresentation = Schema.encodeSync(ActionPresentation);

/** Retain the first User-visible presentation for one persisted pending Action. */
export const makeActionPresentationPersistence = (
  storage: DurableObjectStorage,
): ActionPresentationPersistence => ({
  retain: Effect.fn("ActionPresentation.retain")(function* (candidate) {
    return yield* Effect.tryPromise({
      try: () =>
        // oxlint-disable-next-line effecttsgo/async-function -- Durable Object transactions own their Promise callback boundary.
        storage.transaction(async (transaction) => {
          const key = actionPresentationStorageKey(candidate.presentationId);
          const retained = await transaction.get(key);
          if (retained !== undefined) return retained;
          const encoded = encodeActionPresentation(candidate);
          await transaction.put(key, encoded);
          return encoded;
        }),
      catch: (cause) => actionPresentationPersistenceUnavailable("retain", cause),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ActionPresentation)),
      Effect.mapError((cause) =>
        Schema.is(ThinkApprovalUnavailable)(cause)
          ? cause
          : actionPresentationPersistenceUnavailable("decode", cause),
      ),
    );
  }),
});

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

const presentCoreMemoryClearAction = Effect.fn("ActionPresentation.presentCoreMemoryClear")(
  function* (pending: PendingThinkAction) {
    const input = yield* Schema.decodeUnknownEffect(ClearCoreMemoryInput)(
      pending.descriptor.input,
    ).pipe(
      Effect.mapError(
        () =>
          new ActionPresentationUnavailable({
            action: pending.descriptor.action,
            message: "The Core Memory clear input cannot be projected safely",
          }),
      ),
    );
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
  },
);

const presentDocumentDeleteAction = Effect.fn("ActionPresentation.presentDocumentDelete")(
  function* (pending: PendingThinkAction) {
    const input = yield* Schema.decodeUnknownEffect(RetainedDocumentInput)(
      pending.descriptor.input,
    ).pipe(
      Effect.mapError(
        () =>
          new ActionPresentationUnavailable({
            action: pending.descriptor.action,
            message: "The retained-document deletion input cannot be projected safely",
          }),
      ),
    );
    return ActionPresentation.make({
      actionDefinitionVersion: "osfo-delete-generated-document-v1",
      actionId: ActionId.make(pending.descriptor.toolCallId),
      consequences: ["Permanently delete the retained generated document."],
      description: "Delete the exact retained document shown here.",
      fields: [{ label: "Content", name: "contentId", value: input.contentId }],
      operation: "file.delete",
      presentationId: ActionPresentationId.make(pending.executionId),
      title: "Delete generated document",
    });
  },
);

const actionPresentationStorageKey = (presentationId: ActionPresentationId) =>
  `osfo:action-presentation:${presentationId}`;

const actionPresentationPersistenceUnavailable = (operation: string, cause: unknown) =>
  new ThinkApprovalUnavailable({
    cause,
    message: "The retained Action presentation is unavailable",
    operation: `actionPresentation.${operation}`,
  });
