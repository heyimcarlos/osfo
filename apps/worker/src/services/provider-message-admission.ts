import { Effect, Predicate, Schema } from "effect";

import {
  AcceptanceReceiptId,
  type AgentId,
  ChannelBindingId,
  ProviderMessageId,
  ThinkSubmissionId,
  UserMessageId,
} from "../domain";
import type { AuthorizationDenialReason } from "./authorization";
import type { ManagedConversationDenied } from "./managed-conversation";
import type { AcceptanceReceipt } from "./provider-acceptance-receipt";

/* oxlint-disable eslint/no-underscore-dangle -- Effect schemas use the standard _tag discriminator. */

/** Truncated SHA-256 digest of authenticated provider message content. */
export const ProviderContentDigest = Schema.String.check(
  Schema.isMinLength(40),
  Schema.isMaxLength(40),
  Schema.isPattern(/^[0-9a-f]+$/u),
).pipe(Schema.brand("ProviderContentDigest"));

/** Truncated SHA-256 digest of authenticated provider message content. */
export type ProviderContentDigest = typeof ProviderContentDigest.Type;

/** Truncated SHA-256 digest of one stable provider admission identity chain. */
export const ProviderAdmissionIdentityDigest = Schema.String.check(
  Schema.isMinLength(40),
  Schema.isMaxLength(40),
  Schema.isPattern(/^[0-9a-f]+$/u),
).pipe(Schema.brand("ProviderAdmissionIdentityDigest"));

/** Truncated SHA-256 digest of one stable provider admission identity chain. */
export type ProviderAdmissionIdentityDigest = typeof ProviderAdmissionIdentityDigest.Type;

/** First Channel Binding resolution fixed for one authenticated provider event. */
export type InboundRoute =
  | {
      readonly _tag: "Bound";
      readonly agentId: AgentId;
      readonly channelBindingId: ChannelBindingId;
    }
  | { readonly _tag: "Unbound" };

/** Stable identities used to recover one named-Agent acceptance. */
export const AgentRecoveryInput = Schema.Struct({
  channelBindingId: ChannelBindingId,
  providerMessageId: ProviderMessageId,
  receiptId: AcceptanceReceiptId,
  submissionId: ThinkSubmissionId,
  userMessageId: UserMessageId,
});
/** Stable identities used to inspect or recover one named-Agent acceptance. */
export type AgentRecoveryInput = typeof AgentRecoveryInput.Type;

/** Stable facts sent to one named-Agent acceptance RPC. */
export const AgentAcceptanceInput = Schema.Struct({
  ...AgentRecoveryInput.fields,
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000)),
});
/** Stable identities and text used for one fresh named-Agent acceptance. */
export type AgentAcceptanceInput = typeof AgentAcceptanceInput.Type;

/** Observable result shared by authenticated WhatsApp and Telegram adapters. */
export type AdmissionOutcome =
  | { readonly _tag: "MessageAccepted"; readonly receipt: AcceptanceReceipt }
  | { readonly _tag: "MessageDenied"; readonly reason: AuthorizationDenialReason }
  | { readonly _tag: "OnboardingAccepted" };

/** Concrete two-provider seam: immutable routing, Agent recovery, and usage recording. */
export interface Interface<Message, RouteInput, IdentityFailure, Failure> {
  readonly agent: {
    readonly accept: (
      agentId: AgentId,
      input: AgentAcceptanceInput,
    ) => Effect.Effect<AcceptanceReceipt | ManagedConversationDenied, Failure>;
    readonly recover: (
      agentId: AgentId,
      input: AgentRecoveryInput,
    ) => Effect.Effect<AcceptanceReceipt | null, Failure>;
  };
  readonly allowances: {
    readonly recordAcceptedMessage: (receipt: AcceptanceReceipt) => Effect.Effect<void, Failure>;
  };
  readonly identity: {
    readonly deriveAdmission: (
      route: Extract<InboundRoute, { readonly _tag: "Bound" }>,
      providerMessageId: ProviderMessageId,
    ) => Effect.Effect<ProviderAdmissionIdentityDigest, IdentityFailure>;
    readonly deriveContent: (
      message: Message,
    ) => Effect.Effect<ProviderContentDigest, IdentityFailure>;
  };
  readonly message: (message: Message) => {
    readonly providerMessageId: ProviderMessageId;
    readonly text: string;
  };
  readonly onboarding: (message: Message) => Effect.Effect<void, Failure>;
  readonly persistence: {
    readonly admit: (
      route: Extract<InboundRoute, { readonly _tag: "Bound" }>,
    ) => Effect.Effect<void, Failure>;
    readonly route: (input: RouteInput) => Effect.Effect<InboundRoute, Failure>;
  };
  readonly routeInput: (message: Message, contentDigest: ProviderContentDigest) => RouteInput;
}

/** Admit one authenticated provider message into the canonical named Agent. */
export const make = <Message, RouteInput, IdentityFailure, Failure>(
  options: Interface<Message, RouteInput, IdentityFailure, Failure>,
) => ({
  admit: (message: Message): Effect.Effect<AdmissionOutcome, Failure | IdentityFailure> =>
    Effect.gen(function* () {
      const contentDigest = yield* options.identity.deriveContent(message);
      const route = yield* options.persistence.route(options.routeInput(message, contentDigest));
      if (route._tag === "Unbound") {
        yield* options.onboarding(message);
        return { _tag: "OnboardingAccepted" } as const;
      }
      const facts = options.message(message);
      const identityDigest = yield* options.identity.deriveAdmission(
        route,
        facts.providerMessageId,
      );
      const recoveryInput: AgentRecoveryInput = {
        channelBindingId: route.channelBindingId,
        providerMessageId: facts.providerMessageId,
        receiptId: AcceptanceReceiptId.make(`receipt-${identityDigest}`),
        submissionId: ThinkSubmissionId.make(`submission-${identityDigest}`),
        userMessageId: UserMessageId.make(`message-${identityDigest}`),
      };
      const recovered = yield* options.agent.recover(route.agentId, recoveryInput);
      if (recovered !== null) {
        yield* options.allowances.recordAcceptedMessage(recovered);
        return { _tag: "MessageAccepted", receipt: recovered } as const;
      }
      yield* options.persistence.admit(route);
      const receipt = yield* options.agent.accept(route.agentId, {
        ...recoveryInput,
        message: facts.text,
      });
      if (Predicate.isTagged(receipt, "ManagedConversationDenied")) {
        return { _tag: "MessageDenied", reason: receipt.reason } as const;
      }
      yield* options.allowances.recordAcceptedMessage(receipt);
      return { _tag: "MessageAccepted", receipt } as const;
    }),
});
