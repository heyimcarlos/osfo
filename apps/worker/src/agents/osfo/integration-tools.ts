import { action, type Action } from "@cloudflare/think";
import { tool, type ToolSet } from "ai";

import { ActionId } from "../../domain/action-execution";
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

type IntegrationToolInput =
  | typeof CalendarCreatePrivateInput.Type
  | typeof CalendarListEventsInput.Type
  | typeof CalendarUpdateEventInput.Type
  | typeof DriveGetMetadataInput.Type
  | typeof GmailFetchThreadInput.Type
  | typeof GmailMessageInput.Type;
type IntegrationToolResult = IntegrationEffectCompleted | IntegrationReadCompleted;

export interface IntegrationToolExecutor {
  readonly executeEffect: (
    operation: string,
    input: IntegrationToolInput,
    actionId: ActionId,
  ) => Promise<IntegrationToolResult>;
  readonly executeRead: (
    operation: string,
    input: IntegrationToolInput,
  ) => Promise<IntegrationToolResult>;
}

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
      execute: (input) => executor.executeRead("CALENDAR_LIST_EVENTS", input),
      inputSchema: effectToolSchema(CalendarListEventsInput),
    }),
    driveGetMetadata: tool({
      description: "Read bounded metadata for one exact Google Drive file ID.",
      execute: (input) => executor.executeRead("DRIVE_GET_METADATA", input),
      inputSchema: effectToolSchema(DriveGetMetadataInput),
    }),
    gmailFetchThread: tool({
      description: "Read at most 20 messages from one exact Gmail thread without attachments.",
      execute: (input) => executor.executeRead("GMAIL_FETCH_THREAD", input),
      inputSchema: effectToolSchema(GmailFetchThreadInput),
    }),
  } satisfies ToolSet;
  const actions = {
    calendarCreatePrivate: action({
      description: "Create one private Google Calendar event with no attendees or notifications.",
      execute: (input, context) =>
        executor.executeEffect("CALENDAR_CREATE_PRIVATE", input, ActionId.make(context.toolCallId)),
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
        executor.executeEffect("CALENDAR_UPDATE_EVENT", input, ActionId.make(context.toolCallId)),
      idempotencyKey: ({ ctx }) => `calendar-update-event:${ctx.toolCallId}`,
      inputSchema: calendarUpdateEventInputSchema,
      kind: "durable-pause",
      permissions: ["integrations:calendar:write"],
    }),
    gmailCreateDraft: action({
      description: "Create one Gmail draft without sending it.",
      execute: (input, context) =>
        executor.executeEffect("GMAIL_CREATE_DRAFT", input, ActionId.make(context.toolCallId)),
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
        executor.executeEffect("GMAIL_SEND_EMAIL", input, ActionId.make(context.toolCallId)),
      idempotencyKey: ({ ctx }) => `gmail-send-email:${ctx.toolCallId}`,
      inputSchema: gmailMessageInputSchema,
      kind: "durable-pause",
      permissions: ["integrations:gmail:send"],
    }),
  };
  return { actions, tools };
};

export * as IntegrationTools from "./integration-tools";
