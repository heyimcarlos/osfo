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
import type { AgentAcceptanceInput, AgentRecoveryInput } from "./provider-message-admission";

/** Expected failure when current Telegram Channel Binding authority cannot be read. */
export class TelegramAuthorizationUnavailable extends Schema.TaggedError<TelegramAuthorizationUnavailable>()(
  "TelegramAuthorizationUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Canonical managed-turn metadata extended with Telegram acceptance identity. */
export const TelegramSubmissionMetadata = Schema.Struct({
  ...ManagedTurnMetadata.fields,
  telegramAcceptance: Schema.Struct({
    channelBindingId: ChannelBindingId,
    providerMessageId: ProviderMessageId,
    sessionId: SessionId,
    userMessageId: UserMessageId,
  }),
});

/** Application-owned projection of one durable Telegram Think submission. */
export interface TelegramSubmissionInspection {
  readonly idempotencyKey: string;
  readonly metadata: typeof TelegramSubmissionMetadata.Type;
  readonly submissionId: ThinkSubmissionId;
}

/** Dependencies required to recover a Telegram acceptance. */
export interface RecoveryInterface<
  Receipt extends AcceptanceReceiptInput = AcceptanceReceiptInput,
  StoreFailure = never,
> extends ProviderAgent.RecoveryInterface<
  typeof TelegramSubmissionMetadata.Type,
  Receipt,
  StoreFailure
> {}

/** Dependencies required to authorize and accept a fresh Telegram message. */
export interface Interface<
  Receipt extends AcceptanceReceiptInput = AcceptanceReceiptInput,
  StoreFailure = never,
> extends ProviderAgent.Interface<
  typeof TelegramSubmissionMetadata.Type,
  Receipt,
  StoreFailure,
  TelegramAuthorizationUnavailable
> {
  readonly authorization: {
    readonly inspect: (
      channelBindingId: ChannelBindingId,
    ) => Effect.Effect<AuthorizationContext, TelegramAuthorizationUnavailable>;
  };
}

/** Accept one currently authorized Telegram message into the canonical Think Session. */
export const accept = <Receipt extends AcceptanceReceiptInput, StoreFailure>(options: {
  readonly dependencies: Interface<Receipt, StoreFailure>;
  readonly input: AgentAcceptanceInput;
}) =>
  ProviderAgent.accept({
    codec: telegramMetadata,
    dependencies: options.dependencies,
    input: options.input,
    provider: "telegram",
  });

/** Recover one Telegram acceptance from its receipt or durable Think submission. */
export const recover = <Receipt extends AcceptanceReceiptInput, StoreFailure>(options: {
  readonly dependencies: RecoveryInterface<Receipt, StoreFailure>;
  readonly input: AgentRecoveryInput;
}) =>
  ProviderAgent.recover({
    codec: telegramMetadata,
    dependencies: options.dependencies,
    input: options.input,
    provider: "telegram",
  });

const telegramMetadata: ProviderAgent.MetadataCodec<typeof TelegramSubmissionMetadata.Type> = {
  make: (managed, input, sessionId) =>
    TelegramSubmissionMetadata.make({
      ...managed,
      telegramAcceptance: {
        channelBindingId: input.channelBindingId,
        providerMessageId: input.providerMessageId,
        sessionId,
        userMessageId: input.userMessageId,
      },
    }),
  read: (metadata) => ({
    allowancePeriodId: metadata.allowancePeriodId,
    channelBindingId: metadata.telegramAcceptance.channelBindingId,
    providerMessageId: metadata.telegramAcceptance.providerMessageId,
    sessionId: metadata.telegramAcceptance.sessionId,
    submissionId: metadata.submissionId,
    userMessageId: metadata.telegramAcceptance.userMessageId,
  }),
};
