import { Effect, Option, Schema } from "effect";

import { ActionId } from "../../domain/action-execution";
import type { UserId } from "../../domain";
import { ContentId } from "../../domain/client-content";
import type {
  ActionApprovalSelection,
  ActionPresentationPersistence,
} from "../../services/action-approvals";
import { ApprovalPresentation } from "../../services/authorization";
import {
  ClearCoreMemoryInput,
  coreMemoryLabelFor,
  type CoreMemoryInspected,
  type CoreMemoryUnavailable,
} from "./core-memory";
import {
  ApprovedCoreMemoryCorrections,
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
import { personalSkillDeleteActionName, SkillDeleteInput } from "./personal-skill-tools";
import type { IntegrationToolInput } from "./integration-tools";
import { ReminderManageInput, reminderManageActionName } from "./reminder-tool-contracts";
import { ResearchReport } from "../../services/research-report";
import { DocumentBuild } from "../../services/document-build";
import { ScheduledEmail } from "../../services/scheduled-email";
import { BrowserEffectInput } from "./browser-task";
import {
  CalendarCreateEventInput,
  CalendarDeleteEventInput,
  CalendarUpdateEventInput,
  DriveDeliverArtifactInput,
  GmailMessageInput,
} from "../../domain/integration-manifest";

/* oxlint-disable eslint/no-underscore-dangle -- Registered Action inputs use their canonical _tag discriminator. */

/** Name registered with Think for retained-document deletion. */
export const documentDeleteActionName = "deleteDocument";
/** Name registered with Think for retained visual-artifact deletion. */
export const artifactDeleteActionName = "deleteArtifact";
/** Name registered with Think for consequence-aware Research Report admission. */
export const researchReportStartActionName = "startResearchReport";
/** Ordinary Document Build Action; no Approval presentation is created. */
export const documentBuildStartActionName = "startDocumentBuild";
/** Approval-gated Action that admits one exact future Gmail effect. */
export const scheduledEmailStartActionName = "scheduleEmail";
/** Bound Scheduled Email Settings projection before any definition-owned presentation work. */
export const scheduledEmailApprovalSelection: ActionApprovalSelection = {
  maximum: 50,
  select: (pending) => pending.descriptor.action === scheduledEmailStartActionName,
};

export const browserApprovalSelection: ActionApprovalSelection = {
  maximum: 50,
  select: (pending) => pending.descriptor.action === "executeBrowserEffect",
};

export const reminderApprovalSelection: ActionApprovalSelection = {
  maximum: 50,
  select: (pending) => pending.descriptor.action === reminderManageActionName,
};

/** Model-visible input for one bounded Research Report admission. */
export const ResearchReportStartInput = ResearchReport.Request;

/** Model-visible identity for Research Report inspection or cancellation. */
export const ResearchReportIdentityInput = Schema.Struct({ workflowId: ResearchReport.WorkflowId });

export const DocumentBuildStartInput = DocumentBuild.Request;
export const DocumentBuildIdentityInput = Schema.Struct({ workflowId: DocumentBuild.WorkflowId });
export const ScheduledEmailStartInput = ScheduledEmail.EncodedRequest;
export type ScheduledEmailStartInput = typeof ScheduledEmailStartInput.Type;
export const ScheduledEmailIdentityInput = Schema.Struct({ workflowId: ScheduledEmail.WorkflowId });

/** Consequence policy used by Think's input-dependent durable Approval gate. */
export const researchReportRequiresApproval = (input: ResearchReport.Request): boolean =>
  input.consequences.length > 0;

/** Exact retained-document identity shown before deletion Approval. */
export const RetainedDocumentInput = Schema.Struct({ contentId: ContentId });

/** Exact retained-document identity shown before deletion Approval. */
export type RetainedDocumentInput = typeof RetainedDocumentInput.Type;

/** Project one registered Action into its definition-owned immutable presentation. */
export const presentOsfoAction = Effect.fn("ActionPresentation.present")(function* (
  pending: PendingThinkAction,
  inspectCurrentCoreMemory?: Effect.Effect<CoreMemoryInspected, CoreMemoryUnavailable>,
  ownerUserId?: UserId,
) {
  if (pending.descriptor.action === "executeBrowserEffect") {
    const input = yield* Schema.decodeUnknownEffect(BrowserEffectInput)(
      pending.descriptor.input,
    ).pipe(
      Effect.mapError(
        () =>
          new ActionPresentationUnavailable({
            action: pending.descriptor.action,
            message: "The browser effect cannot be projected safely",
          }),
      ),
    );
    return ActionPresentation.make({
      actionDefinitionVersion: "osfo-browser-effect-v1",
      actionId: ActionId.make(pending.descriptor.toolCallId),
      consequences: [input.consequence],
      description: "Perform this exact interaction on the shown owned browser page.",
      fields: browserPresentationFields(input),
      operation: "browser.effect",
      presentationId: ActionPresentationId.make(pending.executionId),
      title: "Browser interaction",
    });
  }
  if (pending.descriptor.action === reminderManageActionName) {
    return yield* presentReminderManageAction(pending, ownerUserId);
  }
  if (pending.descriptor.action === "osfoClearCoreMemory") {
    return yield* presentCoreMemoryClearAction(pending);
  }
  if (pending.descriptor.action === documentDeleteActionName) {
    return yield* presentDocumentDeleteAction(pending);
  }
  if (pending.descriptor.action === artifactDeleteActionName) {
    return yield* presentArtifactDeleteAction(pending);
  }
  if (pending.descriptor.action === researchReportStartActionName) {
    return yield* presentResearchReportStartAction(pending);
  }
  if (pending.descriptor.action === scheduledEmailStartActionName) {
    return yield* presentScheduledEmailStartAction(pending);
  }
  if (pending.descriptor.action === forgetKnowledgeActionName) {
    return yield* presentForgetKnowledgeAction(pending, inspectCurrentCoreMemory);
  }
  if (pending.descriptor.action === sessionDeleteActionName) {
    return yield* presentSessionDeleteAction(pending);
  }
  if (pending.descriptor.action === personalSkillDeleteActionName) {
    return yield* presentPersonalSkillDeleteAction(pending);
  }
  if (pending.descriptor.action === "calendarUpdateEvent") {
    return yield* presentCalendarUpdateAction(pending);
  }
  if (pending.descriptor.action === "calendarCreateEvent") {
    return yield* presentCalendarCreateAction(pending);
  }
  if (pending.descriptor.action === "calendarDeleteEvent") {
    return yield* presentCalendarDeleteAction(pending);
  }
  if (pending.descriptor.action === "driveDeliverArtifact") {
    return yield* presentDriveDeliveryAction(pending);
  }
  if (pending.descriptor.action === "gmailSendEmail") {
    return yield* presentGmailSendAction(pending);
  }
  return yield* new ActionPresentationUnavailable({
    action: pending.descriptor.action,
    message: "The Action has no safe presentation projection",
  });
});

export const hasExactBrowserInput = (presentation: ActionPresentation, input: BrowserEffectInput) =>
  hasExactFields(
    presentation,
    "browser.effect",
    "osfo-browser-effect-v1",
    browserPresentationFields(input),
  );

const browserPresentationFields = (input: BrowserEffectInput) => [
  { label: "Destination", name: "url", value: input.expectedUrl },
  { label: "Visible target", name: "target", value: input.targetDescription },
  {
    label: "Exact interaction",
    name: "interaction",
    value: Schema.encodeSync(Schema.fromJsonString(BrowserEffectInput.fields.interaction))(
      input.interaction,
    ),
  },
  { label: "Consequence", name: "consequence", value: input.consequence },
  { label: "Browser task", name: "taskId", value: input.taskId },
  { label: "Page observation", name: "observationId", value: input.observationId },
];

/** Verify every protected Reminder fact against the immutable approved projection. */
export const hasExactReminderManageInput = (
  presentation: ActionPresentation,
  input: ReminderManageInput,
  ownerUserId: UserId,
  actionId: ActionId,
): boolean =>
  hasExactFields(
    presentation,
    "reminder.manage",
    "osfo-reminder-manage-v1",
    reminderPresentationFields(input, ownerUserId, actionId),
  );

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
  operation: "artifact.delete" | "file.delete" | "memory.clear",
  value: string,
): boolean => {
  const expected =
    operation === "artifact.delete"
      ? { actionDefinitionVersion: "osfo-delete-generated-artifact-v1", field: "contentId" }
      : operation === "file.delete"
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
): boolean => Option.isSome(approvedForgetKnowledgeCorrections(presentation, input));

/** Recover the immutable server-observed preimages paired with the exact approved correction. */
export const approvedForgetKnowledgeCorrections = (
  presentation: ActionPresentation,
  input: typeof ForgetKnowledgeInput.Encoded,
): Option.Option<typeof ApprovedCoreMemoryCorrections.Type> => {
  const preimages = Schema.decodeOption(
    Schema.fromJsonString(
      Schema.Array(
        Schema.Struct({
          block: Schema.Literals(["userContext", "agentNotes"]),
          expectedContent: Schema.String.check(Schema.isMaxLength(10_000)),
        }),
      ),
    ),
  )(readSplitPresentationField(presentation.fields, "coreMemoryPreimages"));
  return Option.flatMap(preimages, (decoded) => {
    const approved = input.coreMemory.map((replacement) => {
      const preimage = decoded.find(({ block }) => block === replacement.block);
      return preimage === undefined ? undefined : { ...replacement, ...preimage };
    });
    if (approved.some((replacement) => replacement === undefined)) return Option.none();
    const candidate = approved.filter((replacement) => replacement !== undefined);
    return Schema.decodeUnknownOption(ApprovedCoreMemoryCorrections)(candidate).pipe(
      Option.filter(() =>
        hasExactFields(
          presentation,
          "memory.forgetKnowledge",
          "osfo-forget-knowledge-v2",
          forgetKnowledgePresentationFields(input, decoded),
        ),
      ),
    );
  });
};

/** Verify the exact Session selected for deletion. */
export const hasExactSessionDeleteInput = (
  presentation: ActionPresentation,
  input: typeof SessionDeleteInput.Encoded,
): boolean =>
  hasExactFields(presentation, "session.delete", "osfo-session-delete-v1", [
    { name: "sessionId", value: input.sessionId },
  ]);

/** Verify the exact personal Skill lineage selected for permanent deletion. */
export const hasExactPersonalSkillDeleteInput = (
  presentation: ActionPresentation,
  input: typeof SkillDeleteInput.Encoded,
): boolean =>
  hasExactFields(presentation, "skill.manage", "osfo-personal-skill-delete-v1", [
    { name: "skillId", value: input.skillId },
    { name: "expectedSkillVersion", value: input.expectedSkillVersion },
  ]);

/** Verify the exact protected integration effect shown to the User. */
export const hasExactIntegrationActionInput = (
  presentation: ActionPresentation,
  operation: string,
  input: IntegrationToolInput,
): boolean => {
  if (operation === "GMAIL_SEND_EMAIL") {
    const decoded = Schema.decodeUnknownOption(GmailMessageInput)(input);
    return Option.isSome(decoded)
      ? hasExactFields(
          presentation,
          "integration.effect",
          "osfo-gmail-send-v1",
          gmailPresentationFields(decoded.value),
        )
      : false;
  }
  if (operation === "CALENDAR_UPDATE_EVENT") {
    const decoded = Schema.decodeUnknownOption(CalendarUpdateEventInput)(input);
    return Option.isSome(decoded)
      ? hasExactFields(
          presentation,
          "integration.effect",
          "osfo-calendar-update-v1",
          calendarUpdatePresentationFields(decoded.value),
        )
      : false;
  }
  if (operation === "CALENDAR_CREATE_EVENT") {
    const decoded = Schema.decodeUnknownOption(CalendarCreateEventInput)(input);
    return Option.isSome(decoded)
      ? hasExactFields(
          presentation,
          "integration.effect",
          "osfo-calendar-create-v1",
          calendarCreatePresentationFields(decoded.value),
        )
      : false;
  }
  if (operation === "CALENDAR_DELETE_EVENT") {
    const decoded = Schema.decodeUnknownOption(CalendarDeleteEventInput)(input);
    return Option.isSome(decoded)
      ? hasExactFields(
          presentation,
          "integration.effect",
          "osfo-calendar-delete-v1",
          calendarDeletePresentationFields(decoded.value),
        )
      : false;
  }
  if (operation === "DRIVE_DELIVER_ARTIFACT") {
    const decoded = Schema.decodeUnknownOption(DriveDeliverArtifactInput)(input);
    return Option.isSome(decoded)
      ? hasExactFields(
          presentation,
          "integration.effect",
          "osfo-drive-delivery-v1",
          driveDeliveryPresentationFields(decoded.value),
        )
      : false;
  }
  return false;
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

/** Verify that a protected Research Report start still matches its approved request. */
export const hasExactResearchReportStartInput = (
  presentation: ActionPresentation,
  input: ResearchReport.Request,
): boolean => {
  const fields = researchReportPresentationFields(input);
  return (
    presentation.operation === "workflow.manage" &&
    presentation.actionDefinitionVersion === "osfo-research-report-start-v1" &&
    presentation.fields.length === fields.length &&
    presentation.fields.every(
      (field, index) => field.name === fields[index]?.name && field.value === fields[index]?.value,
    )
  );
};

/** Verify the exact future Gmail effect shown at the User decision boundary. */
export const hasExactScheduledEmailStartInput = (
  presentation: ActionPresentation,
  input: ScheduledEmail.Request,
): boolean =>
  hasExactFields(
    presentation,
    "integration.effect",
    "osfo-scheduled-email-start-v1",
    scheduledEmailPresentationFields(input),
  );

const presentScheduledEmailStartAction = Effect.fn("ActionPresentation.presentScheduledEmailStart")(
  function* (pending: PendingThinkAction) {
    const input = yield* Schema.decodeUnknownEffect(ScheduledEmail.EncodedRequest)(
      pending.descriptor.input,
    ).pipe(
      Effect.mapError(
        () =>
          new ActionPresentationUnavailable({
            action: pending.descriptor.action,
            message: "The Scheduled Email input cannot be projected safely",
          }),
      ),
    );
    return ActionPresentation.make({
      actionDefinitionVersion: "osfo-scheduled-email-start-v1",
      actionId: ActionId.make(pending.descriptor.toolCallId),
      consequences: [
        "At the exact scheduled instant, send this message from the connected primary Gmail mailbox.",
      ],
      description: "Schedule the exact Gmail message and send time shown here.",
      fields: scheduledEmailPresentationFields(input),
      operation: "integration.effect",
      presentationId: ActionPresentationId.make(pending.executionId),
      title: "Schedule Gmail message",
    });
  },
);

const presentGmailSendAction = Effect.fn("ActionPresentation.presentGmailSend")(function* (
  pending: PendingThinkAction,
) {
  const input = yield* Schema.decodeUnknownEffect(GmailMessageInput)(pending.descriptor.input).pipe(
    Effect.mapError(
      () =>
        new ActionPresentationUnavailable({
          action: pending.descriptor.action,
          message: "The Gmail send input cannot be projected safely",
        }),
    ),
  );
  return ActionPresentation.make({
    actionDefinitionVersion: "osfo-gmail-send-v1",
    actionId: ActionId.make(pending.descriptor.toolCallId),
    consequences: ["Send this exact message to the listed external recipients."],
    description: "Send the exact Gmail message shown here.",
    fields: gmailPresentationFields(input),
    operation: "integration.effect",
    presentationId: ActionPresentationId.make(pending.executionId),
    title: "Send Gmail message",
  });
});

const presentReminderManageAction = Effect.fn("ActionPresentation.presentReminderManage")(
  function* (pending: PendingThinkAction, ownerUserId?: UserId) {
    if (ownerUserId === undefined) {
      return yield* new ActionPresentationUnavailable({
        action: pending.descriptor.action,
        message: "The Reminder owner cannot be bound to the presentation",
      });
    }
    const input = yield* Schema.decodeUnknownEffect(ReminderManageInput)(
      pending.descriptor.input,
    ).pipe(
      Effect.mapError(
        () =>
          new ActionPresentationUnavailable({
            action: pending.descriptor.action,
            message: "The Reminder input cannot be projected safely",
          }),
      ),
    );
    const actionId = ActionId.make(pending.descriptor.toolCallId);
    const creating = input._tag.startsWith("Create");
    const reactivating = input._tag.startsWith("Reactivate");
    return ActionPresentation.make({
      actionDefinitionVersion: "osfo-reminder-manage-v1",
      actionId,
      consequences: [
        creating
          ? "Create and activate this exact Reminder."
          : reactivating
            ? "Reactivate this paused Reminder with the exact replacement facts shown here."
            : "Replace the current active Reminder facts with this exact revision.",
        "At each due occurrence, ask the User to return through the fixed WhatsApp Wake-up template.",
      ],
      description: "Commit the exact private Reminder body and fixed schedule shown here.",
      fields: reminderPresentationFields(input, ownerUserId, actionId),
      operation: "reminder.manage",
      presentationId: ActionPresentationId.make(pending.executionId),
      title: creating
        ? "Create Reminder"
        : reactivating
          ? "Reactivate Reminder"
          : "Change Reminder",
    });
  },
);

const presentCalendarUpdateAction = Effect.fn("ActionPresentation.presentCalendarUpdate")(
  function* (pending: PendingThinkAction) {
    const input = yield* Schema.decodeUnknownEffect(CalendarUpdateEventInput)(
      pending.descriptor.input,
    ).pipe(
      Effect.mapError(
        () =>
          new ActionPresentationUnavailable({
            action: pending.descriptor.action,
            message: "The Calendar update input cannot be projected safely",
          }),
      ),
    );
    return ActionPresentation.make({
      actionDefinitionVersion: "osfo-calendar-update-v1",
      actionId: ActionId.make(pending.descriptor.toolCallId),
      consequences: [
        "Overwrite the selected fields on this exact external calendar event ID; a recurring master ID updates its series.",
      ],
      description: "Update the exact Google Calendar event ID shown here.",
      fields: calendarUpdatePresentationFields(input),
      operation: "integration.effect",
      presentationId: ActionPresentationId.make(pending.executionId),
      title: "Update calendar event",
    });
  },
);

const presentCalendarCreateAction = Effect.fn("ActionPresentation.presentCalendarCreate")(
  function* (pending: PendingThinkAction) {
    const input = yield* decodeIntegrationPresentation(
      CalendarCreateEventInput,
      pending,
      "The Calendar create input cannot be projected safely",
    );
    return ActionPresentation.make({
      actionDefinitionVersion: "osfo-calendar-create-v1",
      actionId: ActionId.make(pending.descriptor.toolCallId),
      consequences: ["Create this exact external calendar event or recurring series."],
      description: "Create the exact private Google Calendar event shown here.",
      fields: calendarCreatePresentationFields(input),
      operation: "integration.effect",
      presentationId: ActionPresentationId.make(pending.executionId),
      title: "Create calendar event",
    });
  },
);

const presentCalendarDeleteAction = Effect.fn("ActionPresentation.presentCalendarDelete")(
  function* (pending: PendingThinkAction) {
    const input = yield* decodeIntegrationPresentation(
      CalendarDeleteEventInput,
      pending,
      "The Calendar delete input cannot be projected safely",
    );
    return ActionPresentation.make({
      actionDefinitionVersion: "osfo-calendar-delete-v1",
      actionId: ActionId.make(pending.descriptor.toolCallId),
      consequences: [
        "Delete this exact external calendar event ID; a recurring master ID deletes its series.",
      ],
      description: "Delete the exact Google Calendar event ID shown here.",
      fields: calendarDeletePresentationFields(input),
      operation: "integration.effect",
      presentationId: ActionPresentationId.make(pending.executionId),
      title: "Delete calendar event",
    });
  },
);

const presentDriveDeliveryAction = Effect.fn("ActionPresentation.presentDriveDelivery")(function* (
  pending: PendingThinkAction,
) {
  const input = yield* decodeIntegrationPresentation(
    DriveDeliverArtifactInput,
    pending,
    "The Drive delivery input cannot be projected safely",
  );
  return ActionPresentation.make({
    actionDefinitionVersion: "osfo-drive-delivery-v1",
    actionId: ActionId.make(pending.descriptor.toolCallId),
    consequences: ["Upload this exact owned artifact as a new private Google Drive file."],
    description: "Deliver the exact Osfo-owned document shown here.",
    fields: driveDeliveryPresentationFields(input),
    operation: "integration.effect",
    presentationId: ActionPresentationId.make(pending.executionId),
    title: "Deliver document to Drive",
  });
});

const decodeIntegrationPresentation = <T, E>(
  schema: Schema.Codec<T, E>,
  pending: PendingThinkAction,
  message: string,
) =>
  Schema.decodeUnknownEffect(schema)(pending.descriptor.input).pipe(
    Effect.mapError(
      () => new ActionPresentationUnavailable({ action: pending.descriptor.action, message }),
    ),
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

const presentResearchReportStartAction = Effect.fn("ActionPresentation.presentResearchReportStart")(
  function* (pending: PendingThinkAction) {
    const input = yield* Schema.decodeUnknownEffect(ResearchReportStartInput)(
      pending.descriptor.input,
    ).pipe(
      Effect.mapError(
        () =>
          new ActionPresentationUnavailable({
            action: pending.descriptor.action,
            message: "The Research Report request cannot be projected safely",
          }),
      ),
    );
    return ActionPresentation.make({
      actionDefinitionVersion: "osfo-research-report-start-v1",
      actionId: ActionId.make(pending.descriptor.toolCallId),
      consequences: input.consequences.map(
        (consequence) => `Allow this Research Report to perform: ${consequence}.`,
      ),
      description: "Start the exact bounded Research Report shown here.",
      fields: researchReportPresentationFields(input),
      operation: "workflow.manage",
      presentationId: ActionPresentationId.make(pending.executionId),
      title: "Start Research Report",
    });
  },
);

const researchReportPresentationFields = (input: ResearchReport.Request) => [
  { label: "Topic", name: "topic", value: input.topic },
  { label: "Queries", name: "queries", value: JSON.stringify(input.queries) },
  { label: "Format", name: "format", value: input.format },
  {
    label: "Consequences",
    name: "consequences",
    value: JSON.stringify(input.consequences),
  },
];

const presentArtifactDeleteAction = Effect.fn("ActionPresentation.presentArtifactDelete")(
  function* (pending: PendingThinkAction) {
    const input = yield* Schema.decodeUnknownEffect(RetainedDocumentInput)(
      pending.descriptor.input,
    ).pipe(
      Effect.mapError(
        () =>
          new ActionPresentationUnavailable({
            action: pending.descriptor.action,
            message: "The retained-artifact deletion input cannot be projected safely",
          }),
      ),
    );
    return ActionPresentation.make({
      actionDefinitionVersion: "osfo-delete-generated-artifact-v1",
      actionId: ActionId.make(pending.descriptor.toolCallId),
      consequences: ["Permanently delete the retained generated artifact."],
      description: "Delete the exact retained artifact shown here.",
      fields: [{ label: "Content", name: "contentId", value: input.contentId }],
      operation: "artifact.delete",
      presentationId: ActionPresentationId.make(pending.executionId),
      title: "Delete generated artifact",
    });
  },
);

const presentPersonalSkillDeleteAction = Effect.fn("ActionPresentation.presentPersonalSkillDelete")(
  function* (pending: PendingThinkAction) {
    const input = yield* Schema.decodeUnknownEffect(SkillDeleteInput)(
      pending.descriptor.input,
    ).pipe(
      Effect.mapError(
        () =>
          new ActionPresentationUnavailable({
            action: pending.descriptor.action,
            message: "The personal Skill deletion input cannot be projected safely",
          }),
      ),
    );
    return ActionPresentation.make({
      actionDefinitionVersion: "osfo-personal-skill-delete-v1",
      actionId: ActionId.make(pending.descriptor.toolCallId),
      consequences: [
        "Permanently delete this personal Skill, its immutable versions, and linked learning state.",
      ],
      description: "Delete the exact personal Skill lineage shown here.",
      fields: [
        { label: "Skill", name: "skillId", value: input.skillId },
        {
          label: "Current version",
          name: "expectedSkillVersion",
          value: input.expectedSkillVersion,
        },
      ],
      operation: "skill.manage",
      presentationId: ActionPresentationId.make(pending.executionId),
      title: "Delete personal Skill",
    });
  },
);

const presentForgetKnowledgeAction = Effect.fn("ActionPresentation.presentForgetKnowledge")(
  function* (
    pending: PendingThinkAction,
    inspectCurrentCoreMemory?: Effect.Effect<CoreMemoryInspected, CoreMemoryUnavailable>,
  ) {
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
    if (inspectCurrentCoreMemory === undefined) {
      return yield* new ActionPresentationUnavailable({
        action: pending.descriptor.action,
        message: "Current Core Memory cannot be bound to the deletion presentation",
      });
    }
    const current = yield* inspectCurrentCoreMemory.pipe(
      Effect.mapError(
        () =>
          new ActionPresentationUnavailable({
            action: pending.descriptor.action,
            message: "Current Core Memory cannot be inspected safely",
          }),
      ),
    );
    const preimages = input.coreMemory.map(({ block }) => ({
      block,
      expectedContent: current[block].content,
    }));
    const coreMemoryConsequences = input.coreMemory.map(
      ({ block }) => `Immediately replace the ${coreMemoryLabelFor(block)} Core Memory block.`,
    );
    return yield* ActionPresentation.makeEffect({
      actionDefinitionVersion: "osfo-forget-knowledge-v2",
      actionId: ActionId.make(pending.descriptor.toolCallId),
      consequences: [
        ...coreMemoryConsequences,
        `Permanently forget ${input.memoryIds.length} selected Knowledge Base ${input.memoryIds.length === 1 ? "memory" : "memories"}.`,
        "Keep the original Session transcript.",
      ],
      description: "Apply the exact Native Memory correction and provider forgetting shown here.",
      fields: forgetKnowledgePresentationFields(input, preimages),
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

const encodeGmailRecipients = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeCalendarChanges = Schema.encodeSync(
  Schema.fromJsonString(CalendarUpdateEventInput.fields.changes),
);
const encodeCalendarRecurrence = Schema.encodeSync(
  Schema.fromJsonString(CalendarCreateEventInput.fields.recurrence),
);

const gmailPresentationFields = (input: typeof GmailMessageInput.Type) => [
  { label: "Gmail mailbox", name: "gmailResource", value: input.gmailResource },
  { label: "Integration manifest", name: "manifestVersion", value: "gmail-v1" },
  { label: "Recipients", name: "recipients", value: encodeGmailRecipients(input.recipients) },
  { label: "Subject", name: "subject", value: input.subject },
  { label: "Message", name: "body", value: input.body },
];

const scheduledEmailPresentationFields = (input: ScheduledEmail.Request) => [
  { label: "Gmail mailbox", name: "gmailResource", value: input.gmailResource },
  { label: "Recipients", name: "recipients", value: encodeGmailRecipients(input.recipients) },
  { label: "Subject", name: "subject", value: input.subject },
  { label: "Message", name: "body", value: input.body },
  { label: "Send at", name: "scheduledAt", value: input.scheduledAt.toISOString() },
];

const calendarUpdatePresentationFields = (input: typeof CalendarUpdateEventInput.Type) => [
  { label: "Calendar", name: "calendarId", value: input.calendarId },
  { label: "Event", name: "eventId", value: input.eventId },
  {
    label: "Send notifications",
    name: "sendNotifications",
    value: String(input.sendNotifications),
  },
  { label: "Changes", name: "changes", value: encodeCalendarChanges(input.changes) },
];

const calendarCreatePresentationFields = (input: typeof CalendarCreateEventInput.Type) => [
  { label: "Calendar", name: "calendarId", value: input.calendarId },
  { label: "Title", name: "title", value: input.title },
  { label: "Starts", name: "startsAt", value: input.startsAt },
  { label: "Ends", name: "endsAt", value: input.endsAt },
  { label: "Time zone", name: "timeZone", value: input.timeZone },
  { label: "Recurrence", name: "recurrence", value: encodeCalendarRecurrence(input.recurrence) },
  { label: "Attendees", name: "attendeeCount", value: String(input.attendeeCount) },
  {
    label: "Send notifications",
    name: "sendNotifications",
    value: String(input.sendNotifications),
  },
];

const calendarDeletePresentationFields = (input: typeof CalendarDeleteEventInput.Type) => [
  { label: "Calendar", name: "calendarId", value: input.calendarId },
  { label: "Event", name: "eventId", value: input.eventId },
  {
    label: "Send notifications",
    name: "sendNotifications",
    value: String(input.sendNotifications),
  },
];

const driveDeliveryPresentationFields = (input: typeof DriveDeliverArtifactInput.Type) => [
  { label: "Artifact", name: "artifactId", value: input.artifactId },
  { label: "File name", name: "fileName", value: input.fileName },
  { label: "Media type", name: "mediaType", value: input.mediaType },
  { label: "Bytes", name: "expectedBytes", value: String(input.expectedBytes) },
  { label: "Folder", name: "targetFolderId", value: input.targetFolderId ?? "My Drive" },
];

const reminderPresentationFields = (
  input: ReminderManageInput,
  ownerUserId: UserId,
  actionId: ActionId,
) => {
  const creating = input._tag === "CreateOneTime" || input._tag === "CreateRecurring";
  const intervalMilliseconds = "intervalMilliseconds" in input ? input.intervalMilliseconds : null;
  const reminderId = creating ? actionId : input.reminderId;
  const expectedRevision = creating ? "none" : String(input.expectedRevision);
  return [
    { label: "Action", name: "manageKind", value: input._tag },
    { label: "User", name: "ownerUserId", value: ownerUserId },
    { label: "Reminder", name: "reminderId", value: reminderId },
    { label: "Body", name: "body", value: input.body },
    {
      label: "Schedule",
      name: "scheduleKind",
      value: intervalMilliseconds === null ? "oneTime" : "recurring",
    },
    { label: "First due", name: "firstDueAt", value: input.firstDueAt.toISOString() },
    {
      label: "Interval milliseconds",
      name: "intervalMilliseconds",
      value: intervalMilliseconds === null ? "none" : String(intervalMilliseconds),
    },
    { label: "Enabled", name: "enabled", value: "true" },
    { label: "Expected revision", name: "expectedRevision", value: expectedRevision },
    {
      label: "Resulting revision",
      name: "revision",
      value: String(creating ? 1 : input.expectedRevision + 1),
    },
  ];
};

const presentationFieldValueLimit = 2_000;

const forgetKnowledgePresentationFields = (
  input: typeof ForgetKnowledgeInput.Encoded,
  preimages: ReadonlyArray<{ readonly block: string; readonly expectedContent: string }>,
) => [
  // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- Approval fields retain canonical JSON for exact array comparison.
  ...splitExactPresentationField("Provider memories", "memoryIds", JSON.stringify(input.memoryIds)),
  // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- Approval fields retain canonical JSON for exact array comparison.
  ...splitExactPresentationField(
    "Core Memory replacements",
    "coreMemory",
    JSON.stringify(input.coreMemory),
  ),
  // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- Approval fields retain canonical JSON for exact preimage comparison.
  ...splitExactPresentationField(
    "Current Core Memory",
    "coreMemoryPreimages",
    JSON.stringify(preimages),
  ),
];

const readSplitPresentationField = (fields: ActionPresentation["fields"], name: string): string => {
  const direct = fields.find((field) => field.name === name);
  if (direct !== undefined) return direct.value;
  const parts = fields
    .filter((field) => field.name.startsWith(`${name}.`))
    .map((field) => {
      const match = /\.(\d+)-of-(\d+)$/u.exec(field.name);
      return match === null
        ? undefined
        : { index: Number(match[1]), total: Number(match[2]), value: field.value };
    });
  if (parts.some((part) => part === undefined)) return "";
  const exact = parts.filter((part) => part !== undefined);
  const total = exact[0]?.total;
  return total !== undefined &&
    exact.length === total &&
    exact.every((part, index) => part.index === index + 1 && part.total === total)
    ? exact.map(({ value }) => value).join("")
    : "";
};

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
