import { Schema } from "effect";
import type { Effect } from "effect";

import type { ThinkSubmissionUnavailable } from "./think-submission";
import { ChannelBindingId, ProviderMessageId, SessionId, UserMessageId } from "../domain";
import type { ThinkSubmissionId } from "../domain";
import { ManagedTurnMetadata } from "../domain/managed-conversation";
import type { AgentAcceptanceInput, AgentRecoveryInput } from "./whatsapp-admission";
import type { AcceptanceReceiptInput } from "./provider-acceptance-receipt";
import type { AuthorizationContext } from "./authorization";
import * as ProviderAgentAdmission from "./provider-agent-admission";

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
export interface WhatsAppSubmissionIntent {
  readonly idempotencyKey: string;
  readonly message: {
    readonly text: string;
    readonly userMessageId: UserMessageId;
  };
  readonly metadata: typeof WhatsAppSubmissionMetadata.Type;
  readonly submissionId: ThinkSubmissionId;
}

/** Concrete dependencies used by recoverable WhatsApp acceptance inside one named Agent. */
export interface AcceptanceReceiptStore<
  Receipt extends AcceptanceReceiptInput = AcceptanceReceiptInput,
  StoreFailure = never,
> {
  readonly readAcceptanceReceipt: (
    channelBindingId: ChannelBindingId,
    providerMessageId: ProviderMessageId,
  ) => Effect.Effect<Receipt | null, StoreFailure>;
  readonly recordAcceptanceReceipt: (
    input: AcceptanceReceiptInput,
  ) => Effect.Effect<Receipt, StoreFailure>;
}

/** Think inspection capability required by acceptance recovery. */
export interface ThinkSubmissionInspector {
  readonly inspect: (
    submissionId: ThinkSubmissionId,
  ) => Effect.Effect<WhatsAppSubmissionInspection | null, ThinkSubmissionUnavailable>;
}

/** Concrete dependencies used by recoverable WhatsApp acceptance inside one named Agent. */
export interface RecoveryInterface<
  Receipt extends AcceptanceReceiptInput = AcceptanceReceiptInput,
  StoreFailure = never,
> {
  readonly store: AcceptanceReceiptStore<Receipt, StoreFailure>;
  readonly think: ThinkSubmissionInspector;
}

/** Receipt store capability used only when accepting new work. */
export interface AcceptanceReceiptStoreWithSession<
  Receipt extends AcceptanceReceiptInput = AcceptanceReceiptInput,
  StoreFailure = never,
> extends AcceptanceReceiptStore<Receipt, StoreFailure> {
  readonly inspect: Effect.Effect<{ readonly currentSessionId: SessionId }, StoreFailure>;
}

/** Think capabilities used only when accepting new work. */
export interface ThinkSubmissionAcceptor extends ThinkSubmissionInspector {
  readonly submit: (
    input: WhatsAppSubmissionIntent,
  ) => Effect.Effect<{ readonly submissionId: ThinkSubmissionId }, ThinkSubmissionUnavailable>;
}

/** Concrete dependencies used by new WhatsApp acceptance inside one named Agent. */
export interface Interface<
  Receipt extends AcceptanceReceiptInput = AcceptanceReceiptInput,
  StoreFailure = never,
> {
  readonly authorization: {
    readonly inspect: (
      channelBindingId: ChannelBindingId,
    ) => Effect.Effect<AuthorizationContext, WhatsAppAuthorizationUnavailable>;
  };
  readonly store: AcceptanceReceiptStoreWithSession<Receipt, StoreFailure>;
  readonly think: ThinkSubmissionAcceptor;
}

/** Accept or recover one WhatsApp UserMessage through Think and an immutable receipt. */
export const accept = <Receipt extends AcceptanceReceiptInput, StoreFailure>(options: {
  readonly dependencies: Interface<Receipt, StoreFailure>;
  readonly input: AgentAcceptanceInput;
}) =>
  ProviderAgentAdmission.accept({
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
  ProviderAgentAdmission.recover({
    codec: whatsappMetadata,
    dependencies: options.dependencies,
    input: options.input,
    provider: "whatsapp",
  });

const whatsappMetadata: ProviderAgentAdmission.MetadataCodec<
  typeof WhatsAppSubmissionMetadata.Type
> = {
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
