import { action, type Action } from "@cloudflare/think";
import { tool, type ToolSet } from "ai";
import { Schema } from "effect";

import { ActionId } from "../../domain/action-execution";
import { ManifestVersion } from "../../domain";
import {
  CalendarCreatePrivateInput,
  CalendarListEventsInput,
  CalendarUpdateEventInput,
  DriveGetMetadataInput,
  GmailFetchThreadInput,
  GmailMessageInput,
} from "../../domain/integration-manifest";
import type {
  IntegrationEffectCompleted,
  IntegrationReadCompleted,
} from "../../services/integrations";
import { effectToolSchema } from "./effect-tool-schema";

export type IntegrationToolInput =
  | typeof CalendarCreatePrivateInput.Type
  | typeof CalendarListEventsInput.Type
  | typeof CalendarUpdateEventInput.Type
  | typeof DriveGetMetadataInput.Type
  | typeof GmailFetchThreadInput.Type
  | typeof GmailMessageInput.Type;
type IntegrationToolResult = IntegrationEffectCompleted | IntegrationReadCompleted;

export const integrationActionNames = [
  "calendarCreatePrivate",
  "calendarUpdateEvent",
  "gmailCreateDraft",
  "gmailSendEmail",
] as const;

export type IntegrationActionName = (typeof integrationActionNames)[number];

export interface IntegrationOperationIdentity {
  readonly manifestVersion: ManifestVersion;
  readonly operation: string;
  readonly toolkit: string;
}

const operationIdentities = {
  calendarCreatePrivate: {
    manifestVersion: ManifestVersion.make("calendar-v1"),
    operation: "CALENDAR_CREATE_PRIVATE",
    toolkit: "googlecalendar",
  },
  calendarListEvents: {
    manifestVersion: ManifestVersion.make("calendar-v1"),
    operation: "CALENDAR_LIST_EVENTS",
    toolkit: "googlecalendar",
  },
  calendarUpdateEvent: {
    manifestVersion: ManifestVersion.make("calendar-v1"),
    operation: "CALENDAR_UPDATE_EVENT",
    toolkit: "googlecalendar",
  },
  driveGetMetadata: {
    manifestVersion: ManifestVersion.make("drive-v1"),
    operation: "DRIVE_GET_METADATA",
    toolkit: "googledrive",
  },
  gmailCreateDraft: {
    manifestVersion: ManifestVersion.make("gmail-v1"),
    operation: "GMAIL_CREATE_DRAFT",
    toolkit: "gmail",
  },
  gmailFetchThread: {
    manifestVersion: ManifestVersion.make("gmail-v1"),
    operation: "GMAIL_FETCH_THREAD",
    toolkit: "gmail",
  },
  gmailSendEmail: {
    manifestVersion: ManifestVersion.make("gmail-v1"),
    operation: "GMAIL_SEND_EMAIL",
    toolkit: "gmail",
  },
} as const satisfies Record<string, IntegrationOperationIdentity>;

export const operationIdentityFor = (toolName: keyof typeof operationIdentities) =>
  operationIdentities[toolName];

export interface IntegrationToolExecutor {
  readonly executeEffect: (
    identity: IntegrationOperationIdentity,
    input: IntegrationToolInput,
    actionId: ActionId,
  ) => Promise<IntegrationToolResult>;
  readonly executeRead: (
    identity: IntegrationOperationIdentity,
    input: IntegrationToolInput,
    actionId: ActionId,
  ) => Promise<IntegrationToolResult>;
}

/** Safe Agent-boundary failure when current integration authority cannot be established. */
export class IntegrationToolUnavailable extends Schema.TaggedError<IntegrationToolUnavailable>()(
  "IntegrationToolUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

const calendarCreatePrivateInputSchema = effectToolSchema(CalendarCreatePrivateInput);
const calendarUpdateEventInputSchema = effectToolSchema(CalendarUpdateEventInput);
const gmailMessageInputSchema = effectToolSchema(GmailMessageInput);

export interface IntegrationToolRegistry {
  readonly actions: {
    readonly calendarCreatePrivate: Action<
      typeof calendarCreatePrivateInputSchema,
      IntegrationToolResult
    >;
    readonly calendarUpdateEvent: Action<
      typeof calendarUpdateEventInputSchema,
      IntegrationToolResult
    >;
    readonly gmailCreateDraft: Action<typeof gmailMessageInputSchema, IntegrationToolResult>;
    readonly gmailSendEmail: Action<typeof gmailMessageInputSchema, IntegrationToolResult>;
  };
  readonly tools: ToolSet;
}

/** Publish only manifest-owned direct operations with immutable read-vs-Action classification. */
export const make = (executor: IntegrationToolExecutor): IntegrationToolRegistry => {
  const tools = {
    calendarListEvents: tool({
      description: "List at most 10 events in one explicit Google Calendar time window.",
      execute: (input, context) =>
        executor.executeRead(
          operationIdentities.calendarListEvents,
          input,
          ActionId.make(context.toolCallId),
        ),
      inputSchema: effectToolSchema(CalendarListEventsInput),
    }),
    driveGetMetadata: tool({
      description: "Read bounded metadata for one exact Google Drive file ID.",
      execute: (input, context) =>
        executor.executeRead(
          operationIdentities.driveGetMetadata,
          input,
          ActionId.make(context.toolCallId),
        ),
      inputSchema: effectToolSchema(DriveGetMetadataInput),
    }),
    gmailFetchThread: tool({
      description: "Read at most 20 messages from one exact Gmail thread without attachments.",
      execute: (input, context) =>
        executor.executeRead(
          operationIdentities.gmailFetchThread,
          input,
          ActionId.make(context.toolCallId),
        ),
      inputSchema: effectToolSchema(GmailFetchThreadInput),
    }),
  } satisfies ToolSet;
  const actions = {
    calendarCreatePrivate: action({
      description: "Create one private Google Calendar event with no attendees or notifications.",
      execute: (input, context) =>
        executor.executeEffect(
          operationIdentities.calendarCreatePrivate,
          input,
          ActionId.make(context.toolCallId),
        ),
      idempotencyKey: ({ ctx }) => `calendar-create-private:${ctx.toolCallId}`,
      inputSchema: calendarCreatePrivateInputSchema,
      permissions: ["integrations:calendar:write"],
    }),
    calendarUpdateEvent: action({
      approval: true,
      approvalRisk: "high",
      approvalSummary: "Update the exact Google Calendar event fields shown",
      description: "Patch explicit fields on one exact Google Calendar event.",
      execute: (input, context) =>
        executor.executeEffect(
          operationIdentities.calendarUpdateEvent,
          input,
          ActionId.make(context.toolCallId),
        ),
      idempotencyKey: ({ ctx }) => `calendar-update-event:${ctx.toolCallId}`,
      inputSchema: calendarUpdateEventInputSchema,
      kind: "durable-pause",
      permissions: ["integrations:calendar:write"],
    }),
    gmailCreateDraft: action({
      description: "Create one Gmail draft without sending it.",
      execute: (input, context) =>
        executor.executeEffect(
          operationIdentities.gmailCreateDraft,
          input,
          ActionId.make(context.toolCallId),
        ),
      idempotencyKey: ({ ctx }) => `gmail-create-draft:${ctx.toolCallId}`,
      inputSchema: gmailMessageInputSchema,
      permissions: ["integrations:gmail:write"],
    }),
    gmailSendEmail: action({
      approval: true,
      approvalRisk: "high",
      approvalSummary: "Send the exact Gmail message shown",
      description: "Send one exact Gmail message to the listed recipients.",
      execute: (input, context) =>
        executor.executeEffect(
          operationIdentities.gmailSendEmail,
          input,
          ActionId.make(context.toolCallId),
        ),
      idempotencyKey: ({ ctx }) => `gmail-send-email:${ctx.toolCallId}`,
      inputSchema: gmailMessageInputSchema,
      kind: "durable-pause",
      permissions: ["integrations:gmail:send"],
    }),
  };
  return { actions, tools };
};

export * as IntegrationTools from "./integration-tools";
