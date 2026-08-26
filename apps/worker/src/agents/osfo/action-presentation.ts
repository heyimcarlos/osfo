import { Effect, Schema } from "effect";

import { ActionId } from "../../domain/action-execution";
import { ContentId } from "../../domain/client-content";
import type { ActionPresentationPersistence } from "../../services/action-approvals";
import { ApprovalPresentation } from "../../services/authorization";
import { ClearCoreMemoryInput, coreMemoryLabelFor } from "./core-memory";
import {
  ForgetKnowledgeInput,
  forgetKnowledgeActionName,
  SessionDeleteInput,
  sessionDeleteActionName,
} from "./deletion-actions";
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
  if (pending.descriptor.action === forgetKnowledgeActionName) {
    return yield* presentForgetKnowledgeAction(pending);
  }
  if (pending.descriptor.action === sessionDeleteActionName) {
    return yield* presentSessionDeleteAction(pending);
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

/** Verify the complete Knowledge deletion target and Native Memory correction. */
export const hasExactForgetKnowledgeInput = (
  presentation: ActionPresentation,
  input: typeof ForgetKnowledgeInput.Encoded,
): boolean =>
  hasExactFields(
    presentation,
    "memory.forgetKnowledge",
    "osfo-forget-knowledge-v1",
    forgetKnowledgePresentationFields(input),
  );

/** Verify the exact Session selected for deletion. */
export const hasExactSessionDeleteInput = (
  presentation: ActionPresentation,
  input: typeof SessionDeleteInput.Encoded,
): boolean =>
  hasExactFields(presentation, "session.delete", "osfo-session-delete-v1", [
    { name: "sessionId", value: input.sessionId },
  ]);

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

const presentForgetKnowledgeAction = Effect.fn("ActionPresentation.presentForgetKnowledge")(
  function* (pending: PendingThinkAction) {
    const input = yield* Schema.decodeUnknownEffect(ForgetKnowledgeInput)(
      pending.descriptor.input,
    ).pipe(
      Effect.mapError(
        () =>
          new ActionPresentationUnavailable({
            action: pending.descriptor.action,
            message: "The Knowledge deletion input cannot be projected safely",
          }),
      ),
    );
    const coreMemoryConsequences = input.coreMemory.map(
      ({ block }) => `Immediately replace the ${coreMemoryLabelFor(block)} Core Memory block.`,
    );
    return yield* ActionPresentation.makeEffect({
      actionDefinitionVersion: "osfo-forget-knowledge-v1",
      actionId: ActionId.make(pending.descriptor.toolCallId),
      consequences: [
        ...coreMemoryConsequences,
        `Permanently forget ${input.memoryIds.length} selected Knowledge Base ${input.memoryIds.length === 1 ? "memory" : "memories"}.`,
        "Keep the original Session transcript.",
      ],
      description: "Apply the exact Native Memory correction and provider forgetting shown here.",
      fields: forgetKnowledgePresentationFields(input),
      operation: "memory.forgetKnowledge",
      presentationId: ActionPresentationId.make(pending.executionId),
      title: "Forget selected knowledge",
    }).pipe(
      Effect.mapError(
        () =>
          new ActionPresentationUnavailable({
            action: pending.descriptor.action,
            message: "The Knowledge deletion presentation could not be bounded safely",
          }),
      ),
    );
  },
);

const presentSessionDeleteAction = Effect.fn("ActionPresentation.presentSessionDelete")(function* (
  pending: PendingThinkAction,
) {
  const input = yield* Schema.decodeUnknownEffect(SessionDeleteInput)(
    pending.descriptor.input,
  ).pipe(
    Effect.mapError(
      () =>
        new ActionPresentationUnavailable({
          action: pending.descriptor.action,
          message: "The Session deletion input cannot be projected safely",
        }),
    ),
  );
  return ActionPresentation.make({
    actionDefinitionVersion: "osfo-session-delete-v1",
    actionId: ActionId.make(pending.descriptor.toolCallId),
    consequences: [
      "Permanently delete the selected Session transcript and search history.",
      "Create a replacement first when this is the current Session.",
      "Permanently delete the matching Knowledge Base conversation.",
    ],
    description: "Delete the exact Session shown here.",
    fields: [{ label: "Session", name: "sessionId", value: input.sessionId }],
    operation: "session.delete",
    presentationId: ActionPresentationId.make(pending.executionId),
    title: "Delete Session",
  });
});

const hasExactFields = (
  presentation: ActionPresentation,
  operation: string,
  version: string,
  expected: ReadonlyArray<{ readonly name: string; readonly value: string }>,
) =>
  presentation.operation === operation &&
  presentation.actionDefinitionVersion === version &&
  presentation.fields.length === expected.length &&
  expected.every(
    (field, index) =>
      presentation.fields[index]?.name === field.name &&
      presentation.fields[index]?.value === field.value,
  );

const presentationFieldValueLimit = 2_000;

const forgetKnowledgePresentationFields = (input: typeof ForgetKnowledgeInput.Encoded) => [
  // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- Approval fields retain canonical JSON for exact array comparison.
  ...splitExactPresentationField("Provider memories", "memoryIds", JSON.stringify(input.memoryIds)),
  // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- Approval fields retain canonical JSON for exact array comparison.
  ...splitExactPresentationField(
    "Core Memory replacements",
    "coreMemory",
    JSON.stringify(input.coreMemory),
  ),
];

const splitExactPresentationField = (label: string, name: string, value: string) => {
  const partCount = Math.ceil(value.length / presentationFieldValueLimit);
  if (partCount === 1) return [{ label, name, value }];
  return Array.from({ length: partCount }, (_, index) => ({
    label: `${label} (${index + 1}/${partCount})`,
    name: `${name}.${index + 1}-of-${partCount}`,
    value: value.slice(
      index * presentationFieldValueLimit,
      (index + 1) * presentationFieldValueLimit,
    ),
  }));
};

const actionPresentationStorageKey = (presentationId: ActionPresentationId) =>
  `osfo:action-presentation:${presentationId}`;

const actionPresentationPersistenceUnavailable = (operation: string, cause: unknown) =>
  new ThinkApprovalUnavailable({
    cause,
    message: "The retained Action presentation is unavailable",
    operation: `actionPresentation.${operation}`,
  });
