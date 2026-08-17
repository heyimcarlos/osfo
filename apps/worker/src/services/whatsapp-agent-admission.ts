import { Effect, Predicate, Schema } from "effect";

import { ThinkSubmissionUnavailable } from "./think-submission";
import {
  ChannelBindingId,
  ProviderMessageId,
  SessionId,
  type ThinkSubmissionId,
  type UserId,
  UserMessageId,
} from "../domain";
import { ManagedTurnMetadata } from "../domain/managed-conversation";
import { retainedCatalog } from "../domain/plan-policy";
import type { AgentAcceptanceInput } from "./whatsapp-admission";
import type { AcceptanceReceiptInput } from "./whatsapp-acceptance-receipt";
import { make as makeAuthorization } from "./authorization";
import { admitManagedConversation, type ManagedConversationDenied } from "./managed-conversation";

/** Expected failure when current Channel Binding authority cannot be checked. */
export class WhatsAppAuthorityUnavailable extends Schema.TaggedError<WhatsAppAuthorityUnavailable>()(
  "WhatsAppAuthorityUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

const WhatsAppSubmissionMetadata = Schema.Struct({
  ...ManagedTurnMetadata.fields,
  whatsappAcceptance: Schema.Struct({
    channelBindingId: ChannelBindingId,
    providerMessageId: ProviderMessageId,
    sessionId: SessionId,
    userMessageId: UserMessageId,
  }),
});

/** Application-owned acceptance facts persisted by the named Agent. */
/** Application-owned view of a durable Think submission. */
export interface SubmissionInspection {
  readonly idempotencyKey?: string;
  readonly metadata?: unknown;
  readonly submissionId: string;
}

/** Application-owned command for durable Think submission. */
export interface SubmissionInput {
  readonly idempotencyKey: string;
  readonly input: {
    readonly id: UserMessageId;
    readonly parts: Array<{ readonly text: string; readonly type: "text" }>;
    readonly role: "user";
  };
  readonly metadata: typeof WhatsAppSubmissionMetadata.Type;
  readonly mode: "submit";
  readonly submissionId: ThinkSubmissionId;
}

/** Concrete dependencies used by recoverable WhatsApp acceptance inside one named Agent. */
export interface Interface<
  Receipt extends AcceptanceReceiptInput = AcceptanceReceiptInput,
  StoreFailure = never,
> {
  readonly authority: {
    readonly isCurrent: (
      channelBindingId: ChannelBindingId,
      userId: UserId,
    ) => Effect.Effect<boolean, WhatsAppAuthorityUnavailable>;
  };
  readonly store: {
    readonly inspect: () => Effect.Effect<{ readonly currentSessionId: SessionId }, StoreFailure>;
    readonly readAcceptanceReceipt: (
      channelBindingId: ChannelBindingId,
      providerMessageId: ProviderMessageId,
    ) => Effect.Effect<Receipt | null, StoreFailure>;
    readonly recordAcceptanceReceipt: (
      input: AcceptanceReceiptInput,
    ) => Effect.Effect<Receipt, StoreFailure>;
  };
  readonly think: {
    readonly inspect: (
      submissionId: string,
    ) => Effect.Effect<SubmissionInspection | null, ThinkSubmissionUnavailable>;
    readonly submit: (
      input: SubmissionInput,
    ) => Effect.Effect<{ readonly submissionId: string }, ThinkSubmissionUnavailable>;
  };
}

/** Accept or recover one WhatsApp UserMessage through Think and an immutable receipt. */
export const accept = <Receipt extends AcceptanceReceiptInput, StoreFailure>(options: {
  readonly dependencies: Interface<Receipt, StoreFailure>;
  readonly input: AgentAcceptanceInput;
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
    if (inspected !== null) {
      const metadata = yield* Schema.decodeUnknownEffect(WhatsAppSubmissionMetadata)(
        inspected.metadata,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ThinkSubmissionUnavailable({
              cause,
              message: "The accepted WhatsApp submission has invalid recovery facts",
              operation: "inspectSubmission",
            }),
        ),
      );
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
    }

    const userId = input.authorization.resourceOwnerUserId;
    if (userId === null) {
      return {
        _tag: "ManagedConversationDenied",
        reason: "ownershipRequired",
        resetAt: null,
      } satisfies ManagedConversationDenied;
    }
    const currentAuthority = yield* dependencies.authority.isCurrent(
      input.channelBindingId,
      userId,
    );
    if (!currentAuthority) {
      return {
        _tag: "ManagedConversationDenied",
        reason: "authorityRevoked",
        resetAt: null,
      } satisfies ManagedConversationDenied;
    }

    const acceptance = makeAuthorization(retainedCatalog).admit(input.authorization, {
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
      authorization: input.authorization,
      idempotencyKey: `whatsapp-${input.receiptId}`,
      message: input.message,
      submissionId: input.submissionId,
    });
    if (!Predicate.isTagged(managed, "ManagedConversationAdmitted")) return managed;

    const agent = yield* dependencies.store.inspect();
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
      input: {
        id: input.userMessageId,
        parts: [{ text: input.message, type: "text" }],
        role: "user",
      },
      metadata,
      mode: "submit",
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
