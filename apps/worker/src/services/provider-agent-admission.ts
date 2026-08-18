import { Effect, Predicate } from "effect";

import { ThinkSubmissionUnavailable } from "./think-submission";
import { SessionId } from "../domain";
import type {
  AllowancePeriodId,
  ChannelBindingId,
  ConversationRouteId,
  ProviderMessageId,
  ThinkSubmissionId,
  UserMessageId,
} from "../domain";
import type { ManagedTurnMetadata } from "../domain/managed-conversation";
import { retainedCatalog } from "../domain/plan-policy";
import type { AgentAcceptanceInput, AgentRecoveryInput } from "./provider-message-admission";
import type { AcceptanceReceiptInput } from "./provider-acceptance-receipt";
import {
  SessionCommandReceiptConflict,
  type SessionCommandReceipt,
  type SessionCommandReceiptInput,
} from "./session-command-receipt";
import { type AuthorizationContext, make as makeAuthorization } from "./authorization";
import {
  admitManagedConversation,
  type ManagedConversationDenied,
  type ManagedSessionReplacementAdmitted,
} from "./managed-conversation";

/** Provider-specific metadata codec kept at the named-Agent transport boundary. */
export interface MetadataCodec<Metadata extends ManagedTurnMetadata> {
  readonly make: (
    managed: ManagedTurnMetadata,
    input: AgentRecoveryInput,
    sessionId: SessionId,
  ) => Metadata;
  readonly read: (metadata: Metadata) => {
    readonly allowancePeriodId: AllowancePeriodId;
    readonly channelBindingId: ChannelBindingId;
    readonly providerMessageId: ProviderMessageId;
    readonly sessionId: SessionId;
    readonly submissionId: ThinkSubmissionId;
    readonly userMessageId: UserMessageId;
  };
}

/** Durable Think submission facts required to recover a provider acceptance. */
export interface SubmissionInspection<Metadata> {
  readonly idempotencyKey: string;
  readonly metadata: Metadata;
  readonly submissionId: ThinkSubmissionId;
}

/** Stable message and metadata supplied for one idempotent Think submission. */
export interface SubmissionIntent<Metadata> {
  readonly idempotencyKey: string;
  readonly message: {
    readonly text: string;
    readonly userMessageId: UserMessageId;
  };
  readonly metadata: Metadata;
  readonly submissionId: ThinkSubmissionId;
}

/** Named-Agent persistence required to read and record immutable acceptance receipts. */
export interface ReceiptStore<Receipt extends AcceptanceReceiptInput, StoreFailure> {
  readonly readAcceptanceReceipt: (
    channelBindingId: ChannelBindingId,
    providerMessageId: ProviderMessageId,
  ) => Effect.Effect<Receipt | null, StoreFailure>;
  readonly recordAcceptanceReceipt: (
    input: AcceptanceReceiptInput,
  ) => Effect.Effect<Receipt, StoreFailure>;
  readonly readSessionCommandReceipt: (
    channelBindingId: ChannelBindingId,
    providerMessageId: ProviderMessageId,
  ) => Effect.Effect<SessionCommandReceipt | null, StoreFailure>;
}

/** Dependencies required to recover accepted Think work without fresh mutable authority. */
export interface RecoveryInterface<Metadata, Receipt extends AcceptanceReceiptInput, StoreFailure> {
  readonly session: {
    readonly recover: (
      receipt: SessionCommandReceipt,
    ) => Effect.Effect<SessionCommandReceipt, StoreFailure>;
  };
  readonly store: ReceiptStore<Receipt, StoreFailure>;
  readonly think: {
    readonly inspect: (
      submissionId: ThinkSubmissionId,
    ) => Effect.Effect<SubmissionInspection<Metadata> | null, ThinkSubmissionUnavailable>;
  };
}

/** Dependencies required for fresh authorization, canonical routing, and recovery. */
export interface Interface<
  Metadata,
  Receipt extends AcceptanceReceiptInput,
  StoreFailure,
  AuthorizationFailure,
> extends RecoveryInterface<Metadata, Receipt, StoreFailure> {
  readonly authorization: {
    readonly inspect: (
      channelBindingId: ChannelBindingId,
    ) => Effect.Effect<AuthorizationContext, AuthorizationFailure>;
  };
  readonly store: ReceiptStore<Receipt, StoreFailure> & {
    readonly inspect: Effect.Effect<
      {
        readonly currentSessionId: SessionId;
        readonly routeId: ConversationRouteId;
      },
      StoreFailure
    >;
  };
  readonly session: RecoveryInterface<Metadata, Receipt, StoreFailure>["session"] & {
    readonly replace: (
      command: ManagedSessionReplacementAdmitted,
      receipt: SessionCommandReceiptInput,
    ) => Effect.Effect<SessionCommandReceipt, StoreFailure>;
  };
  readonly think: RecoveryInterface<Metadata, Receipt, StoreFailure>["think"] & {
    readonly submit: (
      input: SubmissionIntent<Metadata>,
    ) => Effect.Effect<{ readonly submissionId: ThinkSubmissionId }, ThinkSubmissionUnavailable>;
  };
}

/** Accept through current authority, canonical Think Session, and an immutable receipt. */
export const accept = <
  Metadata extends ManagedTurnMetadata,
  Receipt extends AcceptanceReceiptInput,
  StoreFailure,
  AuthorizationFailure,
>(options: {
  readonly codec: MetadataCodec<Metadata>;
  readonly dependencies: Interface<Metadata, Receipt, StoreFailure, AuthorizationFailure>;
  readonly input: AgentAcceptanceInput;
  readonly provider: "whatsapp";
}) =>
  Effect.gen(function* () {
    const { codec, dependencies, input, provider } = options;
    const recovered = yield* recover({ codec, dependencies, input, provider });
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
    const agent = yield* dependencies.store.inspect;
    const managed = yield* admitManagedConversation(
      {
        authorization,
        idempotencyKey: `${provider}-${input.receiptId}`,
        message: input.message,
        routeId: agent.routeId,
        submissionId: input.submissionId,
      },
      agent,
    );
    if (Predicate.isTagged(managed, "ManagedConversationDenied")) return managed;
    if (Predicate.isTagged(managed, "ManagedSessionReplacementAdmitted")) {
      return yield* dependencies.session.replace(managed, {
        allowancePeriodId: acceptance.allowancePeriod.allowancePeriodId,
        channelBindingId: input.channelBindingId,
        command: "/new",
        providerMessageId: input.providerMessageId,
        receiptId: input.receiptId,
        userMessageId: input.userMessageId,
      });
    }

    const metadata = codec.make(managed.metadata, input, agent.currentSessionId);
    const submitted = yield* dependencies.think.submit({
      idempotencyKey: managed.idempotencyKey,
      message: { text: input.message, userMessageId: input.userMessageId },
      metadata,
      submissionId: managed.submissionId,
    });
    if (submitted.submissionId !== input.submissionId) {
      return yield* new ThinkSubmissionUnavailable({
        cause: submitted,
        message: `Think returned a different ${provider} Submission identity`,
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

/** Recover accepted Think work before consulting fresh mutable authority. */
export const recover = <
  Metadata extends ManagedTurnMetadata,
  Receipt extends AcceptanceReceiptInput,
  StoreFailure,
>(options: {
  readonly codec: MetadataCodec<Metadata>;
  readonly dependencies: RecoveryInterface<Metadata, Receipt, StoreFailure>;
  readonly input: AgentRecoveryInput;
  readonly provider: "whatsapp";
}) =>
  Effect.gen(function* () {
    const { codec, dependencies, input, provider } = options;
    const commandReceipt = yield* dependencies.store.readSessionCommandReceipt(
      input.channelBindingId,
      input.providerMessageId,
    );
    if (commandReceipt !== null) {
      const expectedSessionId = SessionId.make(`session-${input.submissionId}`);
      if (
        commandReceipt.receiptId !== input.receiptId ||
        commandReceipt.userMessageId !== input.userMessageId ||
        commandReceipt.currentSessionId !== expectedSessionId
      ) {
        return yield* new SessionCommandReceiptConflict({
          existingReceiptId: commandReceipt.receiptId,
          existingReplacementSessionId: commandReceipt.currentSessionId,
          existingUserMessageId: commandReceipt.userMessageId,
          message: "The Channel Message Key already has different Session command facts",
          providerMessageId: input.providerMessageId,
          receiptId: input.receiptId,
          requestedReplacementSessionId: expectedSessionId,
          userMessageId: input.userMessageId,
        });
      }
      return yield* dependencies.session.recover(commandReceipt);
    }
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
    const metadata = codec.read(inspected.metadata);
    if (
      inspected.submissionId !== input.submissionId ||
      inspected.idempotencyKey !== `${provider}-${input.receiptId}` ||
      metadata.submissionId !== input.submissionId ||
      metadata.channelBindingId !== input.channelBindingId ||
      metadata.providerMessageId !== input.providerMessageId ||
      metadata.userMessageId !== input.userMessageId
    ) {
      return yield* new ThinkSubmissionUnavailable({
        cause: inspected,
        message: `The accepted ${provider} submission conflicts with its stable identity chain`,
        operation: "inspectSubmission",
      });
    }
    return yield* dependencies.store.recordAcceptanceReceipt({
      allowancePeriodId: metadata.allowancePeriodId,
      channelBindingId: input.channelBindingId,
      providerMessageId: input.providerMessageId,
      receiptId: input.receiptId,
      sessionId: metadata.sessionId,
      thinkSubmissionId: input.submissionId,
      userMessageId: input.userMessageId,
    });
  });
