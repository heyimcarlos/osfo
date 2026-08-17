import { Effect, Option, Schema } from "effect";

import { ActionId } from "../../domain/action-execution";
import { GmailMessageId, GmailSendInput } from "../../domain/gmail";
import {
  ActionPresentation,
  ActionPresentationId,
  ActionPresentationUnavailable,
  type PendingThinkAction,
} from "./think-action-approvals";

const actionName = "gmailSend";
/** Think descriptor input for one exact Gmail send Action. */
export const GmailSendActionInput = Schema.Struct({
  body: GmailSendInput.fields.body,
  recipient: GmailSendInput.fields.recipient,
  scheduledFor: Schema.Null,
  selectedResourceId: Schema.NullOr(GmailMessageId),
  subject: GmailSendInput.fields.subject,
});
/** Think descriptor input for one exact Gmail send Action. */
export type GmailSendActionInput = typeof GmailSendActionInput.Type;

/** Project every material Gmail send field into one immutable Approval presentation. */
export const presentGmailSendAction = (
  pending: PendingThinkAction,
): Effect.Effect<ActionPresentation, ActionPresentationUnavailable> => {
  if (pending.descriptor.action !== actionName) {
    return Effect.fail(
      new ActionPresentationUnavailable({
        action: pending.descriptor.action,
        message: "The Action definition has no Gmail send presentation",
      }),
    );
  }
  return Schema.decodeUnknownEffect(GmailSendActionInput)(pending.descriptor.input).pipe(
    Effect.mapError(
      () =>
        new ActionPresentationUnavailable({
          action: pending.descriptor.action,
          message: "The Gmail send Action input cannot be projected safely",
        }),
    ),
    Effect.map((input) =>
      ActionPresentation.make({
        actionDefinitionVersion: "osfo-gmail-send-v1",
        actionId: ActionId.make(pending.descriptor.toolCallId),
        consequences: ["Send one email with the exact recipient and content shown."],
        description: "Send the exact Gmail message shown here.",
        fields: presentationFields(input),
        operation: "gmail.send",
        presentationId: ActionPresentationId.make(pending.executionId),
        title: "Send Gmail message",
      }),
    ),
  );
};

/** Remove unknown fields from pending Approval output. */
/* oxlint-disable osfo/no-unknown-parameters -- This parser owns Think's untyped descriptor boundary. */
export const sanitizeGmailSendActionInput = (
  input: unknown,
): GmailSendActionInput | Record<string, never> =>
  Schema.decodeUnknownOption(GmailSendActionInput)(input).pipe(
    Option.match({
      onNone: () => ({}),
      onSome: (safe) => safe,
    }),
  );
/* oxlint-enable osfo/no-unknown-parameters */

/** Name registered with Think for the production Gmail send Action. */
export const gmailSendActionName = actionName;

const presentationFields = (input: GmailSendActionInput) => [
  { label: "Recipient", name: "recipient", value: input.recipient },
  { label: "Subject", name: "subject", value: input.subject },
  { label: "Content", name: "body", value: input.body },
  {
    label: "Schedule",
    name: "scheduledFor",
    value: "Send now",
  },
  {
    label: "Gmail resource",
    name: "selectedResourceId",
    value: input.selectedResourceId ?? "New message",
  },
];
