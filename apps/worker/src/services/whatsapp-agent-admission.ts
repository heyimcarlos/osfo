import { Schema } from "effect";
import type { Effect } from "effect";

import {
  ChannelBindingId,
  ProviderMessageId,
  SessionId,
  type ThinkSubmissionId,
  UserMessageId,
} from "../domain";
import { ManagedTurnMetadata } from "../domain/managed-conversation";
import type { AuthorizationContext } from "./authorization";
import * as ProviderAgent from "./provider-agent-admission";
import type { AcceptanceReceiptInput } from "./provider-acceptance-receipt";
import type { AgentAcceptanceInput, AgentRecoveryInput } from "./whatsapp-admission";

/** Expected failure when current WhatsApp authorization facts cannot be checked. */
export class WhatsAppAuthorizationUnavailable extends Schema.TaggedError<WhatsAppAuthorizationUnavailable>()(
  "WhatsAppAuthorizationUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Parsed Think metadata that proves one stable WhatsApp acceptance chain. */
export const WhatsAppSubmissionMetadata = Schema.Struct({
  ...ManagedTurnMetadata.fields,
  whatsappAcceptance: Schema.Struct({
    channelBindingId: ChannelBindingId,
    providerMessageId: ProviderMessageId,
    sessionId: SessionId,
    userMessageId: UserMessageId,
  }),
});

/** Application-owned view of a durable Think submission. */
export interface WhatsAppSubmissionInspection {
  readonly idempotencyKey: string;
  readonly metadata: typeof WhatsAppSubmissionMetadata.Type;
  readonly submissionId: ThinkSubmissionId;
}

/** Application-owned intent for one durable WhatsApp submission. */
export type WhatsAppSubmissionIntent = ProviderAgent.SubmissionIntent<
  typeof WhatsAppSubmissionMetadata.Type
>;

/** Dependencies required to recover a WhatsApp acceptance. */
export interface RecoveryInterface<
  Receipt extends AcceptanceReceiptInput = AcceptanceReceiptInput,
  StoreFailure = never,
> extends ProviderAgent.RecoveryInterface<
  typeof WhatsAppSubmissionMetadata.Type,
  Receipt,
  StoreFailure
> {}

/** Dependencies required to authorize and accept a fresh WhatsApp message. */
export interface Interface<
  Receipt extends AcceptanceReceiptInput = AcceptanceReceiptInput,
  StoreFailure = never,
> extends ProviderAgent.Interface<
  typeof WhatsAppSubmissionMetadata.Type,
  Receipt,
  StoreFailure,
  WhatsAppAuthorizationUnavailable
> {
  readonly authorization: {
    readonly inspect: (
      channelBindingId: ChannelBindingId,
    ) => Effect.Effect<AuthorizationContext, WhatsAppAuthorizationUnavailable>;
  };
}

/** Accept or recover one WhatsApp UserMessage through Think and an immutable receipt. */
export const accept = <Receipt extends AcceptanceReceiptInput, StoreFailure>(options: {
  readonly dependencies: Interface<Receipt, StoreFailure>;
  readonly input: AgentAcceptanceInput;
}) =>
  ProviderAgent.accept({
    codec: whatsappMetadata,
    dependencies: options.dependencies,
    input: options.input,
    provider: "whatsapp",
  });

/** Recover durable Agent acceptance without requiring fresh authority or allowance facts. */
export const recover = <Receipt extends AcceptanceReceiptInput, StoreFailure>(options: {
  readonly dependencies: RecoveryInterface<Receipt, StoreFailure>;
  readonly input: AgentRecoveryInput;
}) =>
  ProviderAgent.recover({
    codec: whatsappMetadata,
    dependencies: options.dependencies,
    input: options.input,
    provider: "whatsapp",
  });

const whatsappMetadata: ProviderAgent.MetadataCodec<typeof WhatsAppSubmissionMetadata.Type> = {
  make: (managed, input, sessionId) =>
    WhatsAppSubmissionMetadata.make({
      ...managed,
      whatsappAcceptance: {
        channelBindingId: input.channelBindingId,
        providerMessageId: input.providerMessageId,
        sessionId,
        userMessageId: input.userMessageId,
      },
    }),
  read: (metadata) => ({
    allowancePeriodId: metadata.allowancePeriodId,
    channelBindingId: metadata.whatsappAcceptance.channelBindingId,
    providerMessageId: metadata.whatsappAcceptance.providerMessageId,
    sessionId: metadata.whatsappAcceptance.sessionId,
    submissionId: metadata.submissionId,
    userMessageId: metadata.whatsappAcceptance.userMessageId,
  }),
};
