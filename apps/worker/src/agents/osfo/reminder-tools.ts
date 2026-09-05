import { action } from "@cloudflare/think";
import { Effect, Schema } from "effect";
import { tool, type ToolSet } from "ai";

import { ActionId } from "../../domain/action-execution";
import { effectToolSchema } from "./effect-tool-schema";
import type { ReminderId, ReminderMutationResult, ReminderRecord } from "./reminders";
import {
  ReminderCancelInput,
  ReminderInspectInput,
  ReminderManageInput,
} from "./reminder-tool-contracts";

export * from "./reminder-tool-contracts";

export interface ReminderToolRegistry {
  readonly actions: {
    readonly osfoManageReminder: ReturnType<typeof reminderAction>;
  };
  readonly tools: ToolSet;
}

interface ReminderCancellationResult {
  readonly _tag: "Canceled";
  readonly reminderId: ReminderId;
  readonly revision: number;
  readonly state: "canceled";
}

export const makeReminderTools = (dependencies: {
  readonly cancel: (
    input: ReminderCancelInput,
    actionId: ActionId,
  ) => Promise<ReminderCancellationResult>;
  readonly inspect: (
    input: ReminderInspectInput,
    actionId: ActionId,
  ) => Promise<ReminderRecord | null>;
  readonly manage: (
    input: ReminderManageInput,
    actionId: ActionId,
  ) => Promise<ReminderMutationResult>;
}): ReminderToolRegistry => ({
  actions: {
    osfoManageReminder: reminderAction(dependencies.manage),
  },
  tools: {
    osfoCancelReminder: tool({
      description: "Cancel one exact active or paused Reminder. Cancellation never needs Approval.",
      execute: (input, context) => dependencies.cancel(input, ActionId.make(context.toolCallId)),
      inputSchema: effectToolSchema(ReminderCancelInput),
    }),
    osfoInspectReminder: tool({
      description: "Inspect one exact User-owned Reminder and its current revision.",
      execute: (input, context) => dependencies.inspect(input, ActionId.make(context.toolCallId)),
      inputSchema: effectToolSchema(ReminderInspectInput),
    }),
  } satisfies ToolSet,
});

const reminderAction = (
  execute: (input: ReminderManageInput, actionId: ActionId) => Promise<ReminderMutationResult>,
) =>
  action({
    approval: true,
    approvalRisk: "medium",
    approvalSummary: "Create or materially change the exact Reminder shown",
    description:
      "Create, materially change, or reactivate one bounded one-time or fixed-elapsed recurring Reminder.",
    execute: (input, context) =>
      Effect.runPromise(decodeReminderActionInput(input)).then((decoded) =>
        execute(decoded, ActionId.make(context.toolCallId)),
      ),
    idempotencyKey: ({ ctx }) => `reminder-manage:${ctx.toolCallId}`,
    inputSchema: effectToolSchema(ReminderManageInput),
    kind: "durable-pause",
    permissions: ["reminders:manage"],
  });

/** Think resumes durable Actions with JSON input, while initial validation supplies a Date. */
export const decodeReminderActionInput = Schema.decodeUnknownEffect(
  Schema.Union([Schema.toType(ReminderManageInput), ReminderManageInput]),
);
