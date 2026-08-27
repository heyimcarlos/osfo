import { action, type Action } from "@cloudflare/think";
// oxlint-disable-next-line osfo/no-import-alias -- The upstream AI Schema collides with Effect Schema in this module.
import { tool, type Schema as AiSchema, type ToolSet } from "ai";
import { Schema } from "effect";

import { ActionId } from "../../domain/action-execution";
import { ManifestVersion } from "../../domain";
import {
  CalendarAvailabilityInput,
  CalendarCreateEventInput,
  CalendarDeleteEventInput,
  CalendarListEventsInput,
  CalendarUpdateEventInput,
  DriveDeliverArtifactInput,
  DriveGetMetadataInput,
  DriveReadFileInput,
  DriveSearchInput,
  GmailFetchThreadInput,
  GmailMessageInput,
  GmailSearchInput,
} from "../../domain/integration-manifest";
import type {
  IntegrationEffectCompleted,
  IntegrationReadCompleted,
} from "../../services/integrations";
import { effectToolSchema } from "./effect-tool-schema";

export type IntegrationToolInput =
  | typeof CalendarAvailabilityInput.Type
  | typeof CalendarCreateEventInput.Type
  | typeof CalendarDeleteEventInput.Type
  | typeof CalendarListEventsInput.Type
  | typeof CalendarUpdateEventInput.Type
  | typeof DriveDeliverArtifactInput.Type
  | typeof DriveGetMetadataInput.Type
  | typeof DriveReadFileInput.Type
  | typeof DriveSearchInput.Type
  | typeof GmailFetchThreadInput.Type
  | typeof GmailMessageInput.Type
  | typeof GmailSearchInput.Type;
type IntegrationToolResult = IntegrationEffectCompleted | IntegrationReadCompleted;

export const integrationActionNames = [
  "calendarCreateEvent",
  "calendarDeleteEvent",
  "calendarUpdateEvent",
  "driveDeliverArtifact",
  "gmailSendEmail",
] as const;

export type IntegrationActionName = (typeof integrationActionNames)[number];

export interface IntegrationOperationIdentity {
  readonly manifestVersion: ManifestVersion;
  readonly operation: string;
  readonly toolkit: string;
}

const integrationIdentity = (
  manifestVersion: string,
  operation: string,
  toolkit: string,
): IntegrationOperationIdentity => ({
  manifestVersion: ManifestVersion.make(manifestVersion),
  operation,
  toolkit,
});

const operationIdentities = {
  calendarCreateEvent: integrationIdentity(
    "calendar-v1",
    "CALENDAR_CREATE_EVENT",
    "googlecalendar",
  ),
  calendarDeleteEvent: integrationIdentity(
    "calendar-v1",
    "CALENDAR_DELETE_EVENT",
    "googlecalendar",
  ),
  calendarFindAvailability: integrationIdentity(
    "calendar-v1",
    "CALENDAR_FIND_AVAILABILITY",
    "googlecalendar",
  ),
  calendarListEvents: integrationIdentity("calendar-v1", "CALENDAR_LIST_EVENTS", "googlecalendar"),
  calendarUpdateEvent: integrationIdentity(
    "calendar-v1",
    "CALENDAR_UPDATE_EVENT",
    "googlecalendar",
  ),
  driveDeliverArtifact: integrationIdentity("drive-v1", "DRIVE_DELIVER_ARTIFACT", "googledrive"),
  driveGetMetadata: integrationIdentity("drive-v1", "DRIVE_GET_METADATA", "googledrive"),
  driveReadFile: integrationIdentity("drive-v1", "DRIVE_READ_FILE", "googledrive"),
  driveSearch: integrationIdentity("drive-v1", "DRIVE_SEARCH", "googledrive"),
  gmailFetchThread: integrationIdentity("gmail-v1", "GMAIL_FETCH_THREAD", "gmail"),
  gmailSearchEmails: integrationIdentity("gmail-v1", "GMAIL_SEARCH_EMAILS", "gmail"),
  gmailSendEmail: integrationIdentity("gmail-v1", "GMAIL_SEND_EMAIL", "gmail"),
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

const calendarCreateEventInputSchema = effectToolSchema(CalendarCreateEventInput);
const calendarDeleteEventInputSchema = effectToolSchema(CalendarDeleteEventInput);
const calendarUpdateEventInputSchema = effectToolSchema(CalendarUpdateEventInput);
const driveDeliverArtifactInputSchema = effectToolSchema(DriveDeliverArtifactInput);
const gmailMessageInputSchema = effectToolSchema(GmailMessageInput);

export interface IntegrationToolRegistry {
  readonly actions: {
    readonly calendarCreateEvent: Action<
      typeof calendarCreateEventInputSchema,
      IntegrationToolResult
    >;
    readonly calendarDeleteEvent: Action<
      typeof calendarDeleteEventInputSchema,
      IntegrationToolResult
    >;
    readonly calendarUpdateEvent: Action<
      typeof calendarUpdateEventInputSchema,
      IntegrationToolResult
    >;
    readonly driveDeliverArtifact: Action<
      typeof driveDeliverArtifactInputSchema,
      IntegrationToolResult
    >;
    readonly gmailSendEmail: Action<typeof gmailMessageInputSchema, IntegrationToolResult>;
  };
  readonly tools: ToolSet;
}

/** Publish only manifest-owned direct operations with immutable read-vs-Action classification. */
export const make = (executor: IntegrationToolExecutor): IntegrationToolRegistry => {
  const tools = {
    calendarFindAvailability: readTool(
      "Find bounded free slots in one explicit Google Calendar time window.",
      CalendarAvailabilityInput,
      operationIdentities.calendarFindAvailability,
      executor,
    ),
    calendarListEvents: readTool(
      "List at most 10 events in one explicit Google Calendar time window.",
      CalendarListEventsInput,
      operationIdentities.calendarListEvents,
      executor,
    ),
    driveGetMetadata: readTool(
      "Read bounded metadata for one exact Google Drive file ID.",
      DriveGetMetadataInput,
      operationIdentities.driveGetMetadata,
      executor,
    ),
    driveReadFile: readTool(
      "Read at most 64 KiB from one exact accessible Google Drive file.",
      DriveReadFileInput,
      operationIdentities.driveReadFile,
      executor,
    ),
    driveSearch: readTool(
      "Search at most 20 files owned by the connected Google Drive account.",
      DriveSearchInput,
      operationIdentities.driveSearch,
      executor,
    ),
    gmailFetchThread: readTool(
      "Read at most 20 messages from one exact Gmail thread without attachments.",
      GmailFetchThreadInput,
      operationIdentities.gmailFetchThread,
      executor,
    ),
    gmailSearchEmails: readTool(
      "Search at most 20 Gmail messages on demand without attachments or mailbox synchronization.",
      GmailSearchInput,
      operationIdentities.gmailSearchEmails,
      executor,
    ),
  } satisfies ToolSet;

  const actions = {
    calendarCreateEvent: approvedAction(
      "Create the exact private Google Calendar event shown",
      "Create one private Google Calendar event with no attendees or notifications.",
      "calendar-create-event",
      calendarCreateEventInputSchema,
      operationIdentities.calendarCreateEvent,
      "integrations:calendar:write",
      executor,
    ),
    calendarDeleteEvent: approvedAction(
      "Delete the exact Google Calendar event or series shown",
      "Delete one exact Google Calendar event or recurring series.",
      "calendar-delete-event",
      calendarDeleteEventInputSchema,
      operationIdentities.calendarDeleteEvent,
      "integrations:calendar:write",
      executor,
    ),
    calendarUpdateEvent: approvedAction(
      "Update the exact Google Calendar event fields shown",
      "Patch explicit fields on one exact Google Calendar event.",
      "calendar-update-event",
      calendarUpdateEventInputSchema,
      operationIdentities.calendarUpdateEvent,
      "integrations:calendar:write",
      executor,
    ),
    driveDeliverArtifact: approvedAction(
      "Deliver the exact owned artifact to Google Drive",
      "Upload one exact Osfo-owned artifact as a new private Google Drive file.",
      "drive-deliver-artifact",
      driveDeliverArtifactInputSchema,
      operationIdentities.driveDeliverArtifact,
      "integrations:drive:write",
      executor,
    ),
    gmailSendEmail: approvedAction(
      "Send the exact Gmail message shown",
      "Send one exact Gmail message to the listed recipients.",
      "gmail-send-email",
      gmailMessageInputSchema,
      operationIdentities.gmailSendEmail,
      "integrations:gmail:send",
      executor,
    ),
  };
  return { actions, tools };
};

const readTool = <T extends IntegrationToolInput, E, RE>(
  description: string,
  input: Schema.Codec<T, E, never, RE>,
  identity: IntegrationOperationIdentity,
  executor: IntegrationToolExecutor,
) =>
  tool({
    description,
    execute: (value, context) =>
      executor.executeRead(identity, value, ActionId.make(context.toolCallId)),
    inputSchema: effectToolSchema(input),
  });

const approvedAction = <T extends IntegrationToolInput>(
  approvalSummary: string,
  description: string,
  idempotencyPrefix: string,
  inputSchema: AiSchema<T>,
  identity: IntegrationOperationIdentity,
  permission: string,
  executor: IntegrationToolExecutor,
) =>
  action({
    approval: true,
    approvalRisk: "high",
    approvalSummary,
    description,
    execute: (input, context) =>
      executor.executeEffect(identity, input, ActionId.make(context.toolCallId)),
    idempotencyKey: ({ ctx }) => `${idempotencyPrefix}:${ctx.toolCallId}`,
    inputSchema,
    kind: "durable-pause",
    permissions: [permission],
  });

export * as IntegrationTools from "./integration-tools";
