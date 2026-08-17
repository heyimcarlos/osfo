import { action } from "@cloudflare/think";
import { Effect, Schema } from "effect";

import { ActionId, type ActionExecutionResult } from "../../domain/action-execution";
import { GmailSendInput } from "../../domain/gmail";
import type { Denied } from "../../services/authorization";
import { GmailSendActionInput } from "./gmail-send-action";

/** Dependencies used when Think releases one exact approved Gmail send. */
export interface GmailSendActionOptions<E> {
  readonly execute: (input: GmailSendInput) => Effect.Effect<ActionExecutionResult | Denied, E>;
}

/** Build the production Gmail Action on Think's sole Action and Approval lifecycle. */
export const makeGmailSendAction = <E>(options: GmailSendActionOptions<E>) =>
  action({
    approval: true,
    approvalRisk: "high",
    approvalSummary: "Send the exact Gmail message",
    description: "Send one exact Gmail message after human Approval.",
    // oxlint-disable-next-line effecttsgo/async-function -- Think Actions require a Promise-returning execute callback.
    execute: async (input, context) =>
      Effect.runPromise(
        options.execute(
          GmailSendInput.make({
            actionId: ActionId.make(context.toolCallId),
            ...input,
          }),
        ),
      ),
    idempotencyKey: ({ ctx }) => `gmail-send:${ctx.toolCallId}`,
    inputSchema: Schema.toStandardSchemaV1(GmailSendActionInput),
    kind: "durable-pause",
    permissions: ["gmail:send"],
  });
