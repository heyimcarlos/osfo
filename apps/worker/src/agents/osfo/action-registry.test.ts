/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the @effect/vitest Effect callback. */
import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";

import type { GmailMessageInput } from "../../domain/integration-manifest";
import { UserId } from "../../domain";
import { ActionId } from "../../domain/action-execution";
import {
  ActionPresentationId,
  ActionPresentationUnavailable,
  type PendingThinkAction,
} from "./think-action-approvals";
import {
  hasExactActionInput,
  hasExactForgetKnowledgeInput,
  hasExactIntegrationActionInput,
  hasExactPersonalSkillDeleteInput,
  hasExactReminderManageInput,
  hasExactResearchReportStartInput,
  hasExactSessionDeleteInput,
  presentOsfoAction,
  researchReportRequiresApproval,
} from "./action-presentation";
import { ForgetKnowledgeInput } from "./deletion-actions";
import { ReminderId } from "./reminders";

it.effect("projects and fences every protected Research Report start fact", () =>
  Effect.gen(function* () {
    const input = {
      consequences: ["externalCommunication" as const],
      format: "pdf" as const,
      queries: ["primary source query", "secondary source query"],
      topic: "Compare the retained primary-source evidence.",
    };
    const presentation = yield* presentOsfoAction({
      descriptor: {
        action: "startResearchReport",
        input,
        kind: "durable-pause",
        permissions: ["workflows:start"],
        requestId: "research-request",
        risk: "high",
        summary: "Start the protected Research Report",
        toolCallId: "research-action",
      },
      executionId: ActionPresentationId.make("research-execution"),
      source: "action",
    });

    expect(presentation).toMatchObject({
      actionDefinitionVersion: "osfo-research-report-start-v1",
      actionId: "research-action",
      operation: "workflow.manage",
      title: "Start Research Report",
    });
    expect(hasExactResearchReportStartInput(presentation, input)).toBe(true);
    expect(
      hasExactResearchReportStartInput(presentation, {
        ...input,
        queries: ["changed after Approval"],
      }),
    ).toBe(false);
    expect(
      hasExactResearchReportStartInput(presentation, {
        ...input,
        topic: "Changed after Approval.",
      }),
    ).toBe(false);
  }),
);

it("does not request Approval for an ordinary Research Report start", () => {
  expect(
    researchReportRequiresApproval({
      consequences: [],
      format: "docx",
      queries: ["bounded public query"],
      topic: "Ordinary cited research",
    }),
  ).toBe(false);
  expect(
    researchReportRequiresApproval({
      consequences: ["externalCommunication"],
      format: "docx",
      queries: ["bounded public query"],
      topic: "Protected cited research",
    }),
  ).toBe(true);
});

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/global-date-in-effect -- Tagged Action fixtures and fixed Approval instants are deliberate. */

it.effect("projects and fences every exact Reminder creation fact", () =>
  Effect.gen(function* () {
    const ownerUserId = UserId.make("reminder-owner");
    const input = {
      _tag: "CreateRecurring" as const,
      body: "Review the household budget.",
      firstDueAt: new Date("2026-08-29T12:00:00.000Z"),
      intervalMilliseconds: 86_400_000,
    };
    const pending: PendingThinkAction = {
      descriptor: {
        action: "osfoManageReminder",
        input: {
          ...input,
          firstDueAt: input.firstDueAt.toISOString(),
        },
        kind: "durable-pause",
        permissions: ["reminders:manage"],
        requestId: "reminder-request",
        risk: "medium",
        summary: "Create the exact Reminder",
        toolCallId: "reminder-action",
      },
      executionId: ActionPresentationId.make("reminder-execution"),
      source: "action",
    };
    const presentation = yield* presentOsfoAction(pending, undefined, ownerUserId);

    expect(presentation).toMatchObject({
      actionDefinitionVersion: "osfo-reminder-manage-v1",
      actionId: "reminder-action",
      operation: "reminder.manage",
      title: "Create Reminder",
    });
    expect(
      hasExactReminderManageInput(
        presentation,
        input,
        ownerUserId,
        ActionId.make("reminder-action"),
      ),
    ).toBe(true);
    expect(
      hasExactReminderManageInput(
        presentation,
        { ...input, body: "Changed after Approval." },
        ownerUserId,
        ActionId.make("reminder-action"),
      ),
    ).toBe(false);
    expect(
      hasExactReminderManageInput(
        presentation,
        input,
        UserId.make("another-owner"),
        ActionId.make("reminder-action"),
      ),
    ).toBe(false);
    expect(
      yield* presentOsfoAction(
        {
          ...pending,
          descriptor: {
            ...pending.descriptor,
            input: { ...input, firstDueAt: "tomorrow morning" },
          },
        },
        undefined,
        ownerUserId,
      ).pipe(
        Effect.flip,
        Effect.map((failure) => failure._tag),
      ),
    ).toBe("ActionPresentationUnavailable");
  }),
);

it.effect("projects the exact material Reminder revision without mutating its Approval", () =>
  Effect.gen(function* () {
    const ownerUserId = UserId.make("reminder-owner");
    const input = {
      _tag: "ChangeRecurring" as const,
      body: "Use the revised private facts.",
      expectedRevision: 3,
      firstDueAt: new Date("2026-08-30T12:00:00.000Z"),
      intervalMilliseconds: 172_800_000,
      reminderId: ReminderId.make("reminder-existing"),
    };
    const pending: PendingThinkAction = {
      descriptor: {
        action: "osfoManageReminder",
        input: { ...input, firstDueAt: input.firstDueAt.toISOString() },
        kind: "durable-pause",
        permissions: ["reminders:manage"],
        requestId: "reminder-change-request",
        risk: "medium",
        summary: "Change the exact Reminder",
        toolCallId: "reminder-change-action",
      },
      executionId: ActionPresentationId.make("reminder-change-execution"),
      source: "action",
    };
    const presentation = yield* presentOsfoAction(pending, undefined, ownerUserId);

    expect(presentation).toMatchObject({
      actionId: "reminder-change-action",
      operation: "reminder.manage",
      title: "Change Reminder",
    });
    expect(presentation.fields).toContainEqual({
      label: "Expected revision",
      name: "expectedRevision",
      value: "3",
    });
    expect(presentation.fields).toContainEqual({
      label: "Resulting revision",
      name: "revision",
      value: "4",
    });
    expect(
      hasExactReminderManageInput(
        presentation,
        input,
        ownerUserId,
        ActionId.make("reminder-change-action"),
      ),
    ).toBe(true);
    expect(
      hasExactReminderManageInput(
        presentation,
        { ...input, expectedRevision: 4 },
        ownerUserId,
        ActionId.make("reminder-change-action"),
      ),
    ).toBe(false);
    expect(
      hasExactReminderManageInput(
        presentation,
        { ...input, _tag: "ReactivateRecurring" },
        ownerUserId,
        ActionId.make("reminder-change-action"),
      ),
    ).toBe(false);

    const reactivation = yield* presentOsfoAction(
      {
        ...pending,
        descriptor: {
          ...pending.descriptor,
          input: {
            ...input,
            _tag: "ReactivateRecurring",
            firstDueAt: input.firstDueAt.toISOString(),
          },
        },
      },
      undefined,
      ownerUserId,
    );
    expect(reactivation.title).toBe("Reactivate Reminder");
    expect(
      hasExactReminderManageInput(
        reactivation,
        input,
        ownerUserId,
        ActionId.make("reminder-change-action"),
      ),
    ).toBe(false);
  }),
);

it.effect("projects the exact retained-document deletion presented for Approval", () =>
  Effect.gen(function* () {
    const pending: PendingThinkAction = {
      descriptor: {
        action: "deleteDocument",
        input: { contentId: "retained-document-1" },
        kind: "durable-pause",
        permissions: ["files:delete"],
        requestId: "request-1",
        risk: "high",
        summary: "Delete the retained generated document",
        toolCallId: "tool-call-1",
      },
      executionId: ActionPresentationId.make("execution-1"),
      source: "action",
    };

    const presentation = yield* presentOsfoAction(pending, currentCoreMemory("Old preference"));

    expect(presentation).toEqual({
      actionDefinitionVersion: "osfo-delete-generated-document-v1",
      actionId: "tool-call-1",
      consequences: ["Permanently delete the retained generated document."],
      description: "Delete the exact retained document shown here.",
      fields: [{ label: "Content", name: "contentId", value: "retained-document-1" }],
      operation: "file.delete",
      presentationId: "execution-1",
      title: "Delete generated document",
    });
    expect(hasExactActionInput(presentation, "file.delete", "retained-document-1")).toBe(true);
    expect(hasExactActionInput(presentation, "file.delete", "retained-document-2")).toBe(false);
  }),
);

it.effect("projects and fences exact immutable artifact deletion", () =>
  Effect.gen(function* () {
    const presentation = yield* presentOsfoAction({
      descriptor: {
        action: "deleteArtifact",
        input: { contentId: "artifact:toolCall:presentation-2" },
        kind: "durable-pause",
        permissions: ["files:delete"],
        requestId: "request-artifact-delete",
        risk: "high",
        summary: "Delete the retained generated artifact",
        toolCallId: "tool-call-artifact-delete",
      },
      executionId: ActionPresentationId.make("execution-artifact-delete"),
      source: "action",
    });

    expect(presentation).toMatchObject({
      actionDefinitionVersion: "osfo-delete-generated-artifact-v1",
      operation: "artifact.delete",
      title: "Delete generated artifact",
    });
    expect(
      hasExactActionInput(presentation, "artifact.delete", "artifact:toolCall:presentation-2"),
    ).toBe(true);
    expect(
      hasExactActionInput(presentation, "artifact.delete", "artifact:toolCall:presentation-other"),
    ).toBe(false);
  }),
);

it.effect("projects the exact Knowledge deletion and Core Memory correction", () =>
  Effect.gen(function* () {
    const pending: PendingThinkAction = {
      descriptor: {
        action: "osfoForgetKnowledge",
        input: {
          coreMemory: [{ block: "userContext", content: "Prefers tea" }],
          memoryIds: ["memory-1", "memory-2"],
        },
        kind: "durable-pause",
        permissions: ["memory:delete"],
        requestId: "request-2",
        risk: "high",
        summary: "Forget selected knowledge",
        toolCallId: "tool-call-2",
      },
      executionId: ActionPresentationId.make("execution-2"),
      source: "action",
    };

    const presentation = yield* presentOsfoAction(pending, currentCoreMemory("Old preference"));

    expect(presentation.operation).toBe("memory.forgetKnowledge");
    expect(presentation.consequences).toEqual([
      "Immediately replace the User Context Core Memory block.",
      "Permanently forget 2 selected Knowledge Base memories.",
      "Keep the original Session transcript.",
    ]);
    expect(
      hasExactForgetKnowledgeInput(presentation, {
        coreMemory: [{ block: "userContext", content: "Prefers tea" }],
        memoryIds: ["memory-1", "memory-2"],
      }),
    ).toBe(true);
    expect(
      hasExactForgetKnowledgeInput(presentation, {
        coreMemory: [{ block: "userContext", content: "Prefers coffee" }],
        memoryIds: ["memory-1", "memory-2"],
      }),
    ).toBe(false);
  }),
);

it.effect("rejects Knowledge forgetting without an exact Core Memory correction", () =>
  Effect.gen(function* () {
    const input = {
      coreMemory: [],
      memoryIds: ["memory-1"],
    };
    const decoded = yield* Schema.decodeUnknownEffect(ForgetKnowledgeInput)(input).pipe(
      Effect.result,
    );
    const presented = yield* presentOsfoAction(
      {
        descriptor: {
          action: "osfoForgetKnowledge",
          input,
          kind: "durable-pause",
          permissions: ["memory:delete"],
          requestId: "request-empty-correction",
          risk: "high",
          summary: "Forget selected knowledge",
          toolCallId: "tool-call-empty-correction",
        },
        executionId: ActionPresentationId.make("execution-empty-correction"),
        source: "action",
      },
      currentCoreMemory("Old preference"),
    ).pipe(Effect.result);

    expect(Result.isFailure(decoded)).toBe(true);
    expect(Result.isFailure(presented)).toBe(true);
    if (Result.isFailure(presented)) {
      expect(presented.failure).toBeInstanceOf(ActionPresentationUnavailable);
    }
  }),
);

it.effect("presents and exactly verifies a near-maximum Core Memory correction", () =>
  Effect.gen(function* () {
    const input = {
      coreMemory: [{ block: "userContext" as const, content: "x".repeat(9_900) }] as const,
      memoryIds: ["memory-near-limit"] as const,
    };
    const presentation = yield* presentOsfoAction(
      {
        descriptor: {
          action: "osfoForgetKnowledge",
          input,
          kind: "durable-pause",
          permissions: ["memory:delete"],
          requestId: "request-near-limit",
          risk: "high",
          summary: "Forget selected knowledge",
          toolCallId: "tool-call-near-limit",
        },
        executionId: ActionPresentationId.make("execution-near-limit"),
        source: "action",
      },
      currentCoreMemory("prior".repeat(2_000)),
    );

    expect(presentation.fields.every(({ value }) => value.length <= 2_000)).toBe(true);
    expect(hasExactForgetKnowledgeInput(presentation, input)).toBe(true);
  }),
);

const currentCoreMemory = (userContext: string) =>
  Effect.succeed({
    _tag: "CoreMemoryInspected" as const,
    agentNotes: { content: "Current agent notes", maxTokens: 800, tokens: 3 },
    userContext: { content: userContext, maxTokens: 1_200, tokens: 3 },
  });

it.effect("projects the exact Session deletion", () =>
  Effect.gen(function* () {
    const pending: PendingThinkAction = {
      descriptor: {
        action: "osfoDeleteSession",
        input: { sessionId: "session-1" },
        kind: "durable-pause",
        permissions: ["sessions:delete"],
        requestId: "request-3",
        risk: "high",
        summary: "Delete one Session",
        toolCallId: "tool-call-3",
      },
      executionId: ActionPresentationId.make("execution-3"),
      source: "action",
    };

    const presentation = yield* presentOsfoAction(pending);

    expect(presentation.operation).toBe("session.delete");
    expect(presentation.consequences).toEqual([
      "Permanently delete the selected Session transcript and search history.",
      "Create a replacement first when this is the current Session.",
      "Permanently delete the matching Knowledge Base conversation.",
    ]);
    expect(hasExactSessionDeleteInput(presentation, { sessionId: "session-1" })).toBe(true);
    expect(hasExactSessionDeleteInput(presentation, { sessionId: "session-2" })).toBe(false);
  }),
);

it.effect("projects and fences exact personal Skill lineage deletion", () =>
  Effect.gen(function* () {
    const pending: PendingThinkAction = {
      descriptor: {
        action: "osfoDeletePersonalSkill",
        input: { expectedSkillVersion: "weekly-status-v3", skillId: "weekly-status" },
        kind: "durable-pause",
        permissions: ["skills:delete"],
        requestId: "request-skill-delete",
        risk: "high",
        summary: "Delete one personal Skill",
        toolCallId: "tool-call-skill-delete",
      },
      executionId: ActionPresentationId.make("execution-skill-delete"),
      source: "action",
    };

    const presentation = yield* presentOsfoAction(pending);

    expect(presentation).toMatchObject({
      actionDefinitionVersion: "osfo-personal-skill-delete-v1",
      operation: "skill.manage",
      title: "Delete personal Skill",
    });
    expect(
      hasExactPersonalSkillDeleteInput(presentation, {
        expectedSkillVersion: "weekly-status-v3",
        skillId: "weekly-status",
      }),
    ).toBe(true);
    expect(
      hasExactPersonalSkillDeleteInput(presentation, {
        expectedSkillVersion: "weekly-status-v2",
        skillId: "weekly-status",
      }),
    ).toBe(false);
  }),
);

it.effect("presents and fences the complete Gmail send", () =>
  Effect.gen(function* () {
    const input = {
      body: "Exact message body",
      recipients: ["first@example.test", "second@example.test"],
      subject: "Exact subject",
    } satisfies typeof GmailMessageInput.Type;
    const presentation = yield* presentOsfoAction({
      descriptor: {
        action: "gmailSendEmail",
        input,
        kind: "durable-pause",
        permissions: ["integrations:gmail:send"],
        requestId: "request-gmail-send",
        risk: "high",
        summary: "Send the exact Gmail message shown",
        toolCallId: "tool-call-gmail-send",
      },
      executionId: ActionPresentationId.make("execution-gmail-send"),
      source: "action",
    });

    expect(presentation).toMatchObject({
      actionDefinitionVersion: "osfo-gmail-send-v1",
      operation: "integration.effect",
      title: "Send Gmail message",
    });
    expect(hasExactIntegrationActionInput(presentation, "GMAIL_SEND_EMAIL", input)).toBe(true);
    expect(
      hasExactIntegrationActionInput(presentation, "GMAIL_SEND_EMAIL", {
        ...input,
        body: "Changed after approval",
      }),
    ).toBe(false);
  }),
);

it.effect("presents and fences the complete Calendar update", () =>
  Effect.gen(function* () {
    const input = {
      calendarId: "calendar-1",
      changes: { location: "Room 2", title: "Updated title" },
      eventId: "event-1",
      sendNotifications: false as const,
    };
    const presentation = yield* presentOsfoAction({
      descriptor: {
        action: "calendarUpdateEvent",
        input,
        kind: "durable-pause",
        permissions: ["integrations:calendar:write"],
        requestId: "request-calendar-update",
        risk: "high",
        summary: "Update the exact Google Calendar event fields shown",
        toolCallId: "tool-call-calendar-update",
      },
      executionId: ActionPresentationId.make("execution-calendar-update"),
      source: "action",
    });

    expect(presentation).toMatchObject({
      actionDefinitionVersion: "osfo-calendar-update-v1",
      operation: "integration.effect",
      title: "Update calendar event",
    });
    expect(hasExactIntegrationActionInput(presentation, "CALENDAR_UPDATE_EVENT", input)).toBe(true);
    expect(
      hasExactIntegrationActionInput(presentation, "CALENDAR_UPDATE_EVENT", {
        ...input,
        changes: { location: "Room 3", title: "Updated title" },
      }),
    ).toBe(false);
  }),
);

it.effect("presents and fences the complete Calendar create", () =>
  Effect.gen(function* () {
    const input = {
      attendeeCount: 0 as const,
      calendarId: "primary",
      endsAt: "2026-09-01T11:00:00-04:00",
      recurrence: { count: 5, frequency: "WEEKLY" as const, interval: 2 },
      sendNotifications: false as const,
      startsAt: "2026-09-01T10:00:00-04:00",
      timeZone: "America/Toronto",
      title: "Planning",
    };
    const presentation = yield* presentOsfoAction({
      descriptor: {
        action: "calendarCreateEvent",
        input,
        kind: "durable-pause",
        permissions: ["integrations:calendar:write"],
        requestId: "request-calendar-create",
        risk: "high",
        summary: "Create the exact Google Calendar event shown",
        toolCallId: "tool-call-calendar-create",
      },
      executionId: ActionPresentationId.make("execution-calendar-create"),
      source: "action",
    });

    expect(presentation).toMatchObject({
      actionDefinitionVersion: "osfo-calendar-create-v1",
      operation: "integration.effect",
      title: "Create calendar event",
    });
    expect(hasExactIntegrationActionInput(presentation, "CALENDAR_CREATE_EVENT", input)).toBe(true);
    expect(
      hasExactIntegrationActionInput(presentation, "CALENDAR_CREATE_EVENT", {
        ...input,
        title: "Changed after approval",
      }),
    ).toBe(false);
  }),
);

it.effect("presents and fences the exact Calendar recurrence deletion target", () =>
  Effect.gen(function* () {
    const input = {
      calendarId: "primary",
      eventId: "recurring-event",
      sendNotifications: false as const,
    };
    const presentation = yield* presentOsfoAction({
      descriptor: {
        action: "calendarDeleteEvent",
        input,
        kind: "durable-pause",
        permissions: ["integrations:calendar:write"],
        requestId: "request-calendar-delete",
        risk: "high",
        summary: "Delete the exact Google Calendar target shown",
        toolCallId: "tool-call-calendar-delete",
      },
      executionId: ActionPresentationId.make("execution-calendar-delete"),
      source: "action",
    });

    expect(presentation).toMatchObject({
      actionDefinitionVersion: "osfo-calendar-delete-v1",
      operation: "integration.effect",
      title: "Delete calendar event",
    });
    expect(hasExactIntegrationActionInput(presentation, "CALENDAR_DELETE_EVENT", input)).toBe(true);
    expect(
      hasExactIntegrationActionInput(presentation, "CALENDAR_DELETE_EVENT", {
        ...input,
        eventId: "different-event",
      }),
    ).toBe(false);
  }),
);

it.effect("presents and fences the complete owned Drive artifact delivery", () =>
  Effect.gen(function* () {
    const input = {
      artifactId: "artifact-1",
      expectedBytes: 12_345,
      fileName: "report.pdf",
      mediaType: "application/pdf" as const,
      targetFolderId: null,
    };
    const presentation = yield* presentOsfoAction({
      descriptor: {
        action: "driveDeliverArtifact",
        input,
        kind: "durable-pause",
        permissions: ["integrations:drive:write"],
        requestId: "request-drive-delivery",
        risk: "high",
        summary: "Deliver the exact owned document shown",
        toolCallId: "tool-call-drive-delivery",
      },
      executionId: ActionPresentationId.make("execution-drive-delivery"),
      source: "action",
    });

    expect(presentation).toMatchObject({
      actionDefinitionVersion: "osfo-drive-delivery-v1",
      operation: "integration.effect",
      title: "Deliver document to Drive",
    });
    expect(hasExactIntegrationActionInput(presentation, "DRIVE_DELIVER_ARTIFACT", input)).toBe(
      true,
    );
    expect(
      hasExactIntegrationActionInput(presentation, "DRIVE_DELIVER_ARTIFACT", {
        ...input,
        expectedBytes: 12_346,
      }),
    ).toBe(false);
  }),
);
