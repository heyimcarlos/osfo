import { Effect, Predicate, Schema } from "effect";

import { ThinkSubmissionUnavailable } from "./think-submission";
import {
  ChannelBindingId,
  ProviderMessageId,
  SessionId,
  type ThinkSubmissionId,
  UserMessageId,
} from "../domain";
import { ManagedTurnMetadata } from "../domain/managed-conversation";
import { retainedCatalog } from "../domain/plan-policy";
import type { AgentAcceptanceInput, AgentRecoveryInput } from "./whatsapp-admission";
import type { AcceptanceReceiptInput } from "./whatsapp-acceptance-receipt";
import { type AuthorizationContext, make as makeAuthorization } from "./authorization";
import { admitManagedConversation, type ManagedConversationDenied } from "./managed-conversation";

/** Expected failure when current WhatsApp authorization facts cannot be checked. */
export class WhatsAppAuthorizationUnavailable extends Schema.TaggedError<WhatsAppAuthorizationUnavailable>()(
  "WhatsAppAuthorizationUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

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
    readonly text: AgentAcceptanceInput["message"];
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
  Effect.gen(function* () {
    const { dependencies, input } = options;
    const recovered = yield* recover({ dependencies, input });
    if (recovered !== null) return recovered;

    const authorization = yield* dependencies.authorization.inspect(input.channelBindingId);

    const acceptance = makeAuthorization(retainedCatalog).admit(authorization, {
      actionId: input.receiptId,
      kind: "conversation.accept",
    });
    if (!Predicate.isTagged(acceptance, "Admitted")) {
      return {
        _tag: "ManagedConversationDenied",
        reason: Predicate.isTagged(acceptance, "Denied") ? acceptance.reason : "approvalRequired",
        resetAt: Predicate.isTagged(acceptance, "Denied") ? acceptance.resetAt : null,
      } satisfies ManagedConversationDenied;
    }
    if (!Predicate.isTagged(acceptance.allowancePeriod, "Metered")) {
      return {
        _tag: "ManagedConversationDenied",
        reason: "allowancePeriodUnavailable",
        resetAt: null,
      } satisfies ManagedConversationDenied;
    }
    const managed = yield* admitManagedConversation({
      authorization,
      idempotencyKey: `whatsapp-${input.receiptId}`,
      message: input.message,
      submissionId: input.submissionId,
    });
    if (!Predicate.isTagged(managed, "ManagedConversationAdmitted")) return managed;

    const agent = yield* dependencies.store.inspect;
    const metadata = WhatsAppSubmissionMetadata.make({
      ...managed.metadata,
      whatsappAcceptance: {
        channelBindingId: input.channelBindingId,
        providerMessageId: input.providerMessageId,
        sessionId: agent.currentSessionId,
        userMessageId: input.userMessageId,
      },
    });
    const submitted = yield* dependencies.think.submit({
      idempotencyKey: managed.idempotencyKey,
      message: {
        text: input.message,
        userMessageId: input.userMessageId,
      },
      metadata,
      submissionId: managed.submissionId,
    });
    if (submitted.submissionId !== input.submissionId) {
      return yield* new ThinkSubmissionUnavailable({
        cause: submitted,
        message: "Think returned a different WhatsApp Submission identity",
        operation: "runTurn",
      });
    }
    return yield* dependencies.store.recordAcceptanceReceipt({
      allowancePeriodId: acceptance.allowancePeriod.allowancePeriodId,
      channelBindingId: input.channelBindingId,
      providerMessageId: input.providerMessageId,
      receiptId: input.receiptId,
      sessionId: agent.currentSessionId,
      thinkSubmissionId: input.submissionId,
      userMessageId: input.userMessageId,
    });
  });

/** Recover durable Agent acceptance without requiring fresh authority or allowance facts. */
export const recover = <Receipt extends AcceptanceReceiptInput, StoreFailure>(options: {
  readonly dependencies: RecoveryInterface<Receipt, StoreFailure>;
  readonly input: AgentRecoveryInput;
}) =>
  Effect.gen(function* () {
    const { dependencies, input } = options;
    const existing = yield* dependencies.store.readAcceptanceReceipt(
      input.channelBindingId,
      input.providerMessageId,
    );
    if (existing !== null) {
      return yield* dependencies.store.recordAcceptanceReceipt({
        allowancePeriodId: existing.allowancePeriodId,
        channelBindingId: input.channelBindingId,
        providerMessageId: input.providerMessageId,
        receiptId: input.receiptId,
        sessionId: existing.sessionId,
        thinkSubmissionId: input.submissionId,
        userMessageId: input.userMessageId,
      });
    }

    const inspected = yield* dependencies.think.inspect(input.submissionId);
    if (inspected === null) return null;
    const metadata = inspected.metadata;
    const expectedIdempotencyKey = `whatsapp-${input.receiptId}`;
    if (
      inspected.submissionId !== input.submissionId ||
      inspected.idempotencyKey !== expectedIdempotencyKey ||
      metadata.submissionId !== input.submissionId ||
      metadata.whatsappAcceptance.channelBindingId !== input.channelBindingId ||
      metadata.whatsappAcceptance.providerMessageId !== input.providerMessageId ||
      metadata.whatsappAcceptance.userMessageId !== input.userMessageId
    ) {
      return yield* new ThinkSubmissionUnavailable({
        cause: inspected,
        message: "The accepted WhatsApp submission conflicts with its stable identity chain",
        operation: "inspectSubmission",
      });
    }
    return yield* dependencies.store.recordAcceptanceReceipt({
      allowancePeriodId: metadata.allowancePeriodId,
      channelBindingId: input.channelBindingId,
      providerMessageId: input.providerMessageId,
      receiptId: input.receiptId,
      sessionId: metadata.whatsappAcceptance.sessionId,
      thinkSubmissionId: input.submissionId,
      userMessageId: input.userMessageId,
    });
  });
