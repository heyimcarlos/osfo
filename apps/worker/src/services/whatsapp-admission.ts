import { Effect, Option, Predicate, Redacted, Schema } from "effect";
import { RegistrationToken } from "@osfo/api";

import {
  AcceptanceReceiptId,
  type AgentId,
  ChannelBindingId,
  ProviderMessageId,
  ThinkSubmissionId,
  UserMessageId,
} from "../domain";
import { AuthorizationContext } from "./authorization";
import type { AcceptanceReceipt } from "./whatsapp-acceptance-receipt";
import type { WhatsAppOnboardingCommand } from "./whatsapp-onboarding";

/* oxlint-disable eslint/no-underscore-dangle -- Effect schemas use the standard _tag discriminator. */

/** Provider-verified WhatsApp sender identity accepted by direct-message admission. */
export const WhatsAppDirectChannelIdentity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(15),
  Schema.isPattern(/^\d+$/u),
).pipe(Schema.brand("ChannelIdentity"));

/** Meta phone-number resource identity accepted by inbound routing. */
export const WhatsAppPhoneNumberId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^\d+$/u),
).pipe(Schema.brand("WhatsAppPhoneNumberId"));

/** Supported direct-message text fixed before hashing, persistence, or Agent RPC. */
export const WhatsAppMessageText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
).pipe(Schema.brand("WhatsAppMessageText"));

/** Supported direct-message facts produced by the authenticated Meta adapter. */
export const InboundWhatsAppMessage = Schema.Union([
  Schema.TaggedStruct("ButtonReply", {
    channelIdentity: WhatsAppDirectChannelIdentity,
    message: WhatsAppMessageText,
    phoneNumberId: WhatsAppPhoneNumberId,
    providerMessageId: ProviderMessageId,
  }),
  Schema.TaggedStruct("TextMessage", {
    channelIdentity: WhatsAppDirectChannelIdentity,
    message: WhatsAppMessageText,
    phoneNumberId: WhatsAppPhoneNumberId,
    providerMessageId: ProviderMessageId,
  }),
]);

/** Supported direct-message facts produced by the authenticated Meta adapter. */
export type InboundWhatsAppMessage = typeof InboundWhatsAppMessage.Type;

/** Provider-event facts fixed before Channel Binding resolution. */
export type RouteInput = InboundWhatsAppMessage & { readonly contentDigest: string };

/** Expected failure when stable inbound identities cannot be derived. */
export class WhatsAppIdentityUnavailable extends Schema.TaggedError<WhatsAppIdentityUnavailable>()(
  "WhatsAppIdentityUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Expected failure when an inbound admission dependency cannot complete its operation. */
export class WhatsAppAdmissionUnavailable extends Schema.TaggedError<WhatsAppAdmissionUnavailable>()(
  "WhatsAppAdmissionUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** First binding resolution fixed for one provider event. */
export type InboundRoute =
  | {
      readonly _tag: "Bound";
      readonly agentId: AgentId;
      readonly channelBindingId: ChannelBindingId;
    }
  | { readonly _tag: "Unbound" };

/** Stable identities used to recover Agent acceptance before new allowance admission. */
export const AgentRecoveryInput = Schema.Struct({
  channelBindingId: ChannelBindingId,
  providerMessageId: ProviderMessageId,
  receiptId: AcceptanceReceiptId,
  submissionId: ThinkSubmissionId,
  userMessageId: UserMessageId,
});

/** Stable identities used to recover Agent acceptance before new allowance admission. */
export type AgentRecoveryInput = typeof AgentRecoveryInput.Type;

/** Stable facts sent to the named Agent acceptance RPC. */
export const AgentAcceptanceInput = Schema.Struct({
  ...AgentRecoveryInput.fields,
  authorization: AuthorizationContext,
  message: WhatsAppMessageText,
});

/** Stable facts sent to the named Agent acceptance RPC. */
export type AgentAcceptanceInput = typeof AgentAcceptanceInput.Type;

/** Observable inbound result used by the HTTP webhook boundary. */
export type AdmissionOutcome =
  | { readonly _tag: "MessageAccepted"; readonly receipt: AcceptanceReceipt }
  | { readonly _tag: "MessageDenied"; readonly reason: string }
  | { readonly _tag: "OnboardingAccepted" };

/** Dependencies required by WhatsApp inbound admission policy. */
export interface Interface<Failure> {
  readonly agent: {
    readonly accept: (
      agentId: AgentId,
      input: AgentAcceptanceInput,
    ) => Effect.Effect<
      AcceptanceReceipt | { readonly _tag: "ManagedConversationDenied"; readonly reason: string },
      Failure
    >;
    readonly recover: (
      agentId: AgentId,
      input: AgentRecoveryInput,
    ) => Effect.Effect<AcceptanceReceipt | null, Failure>;
  };
  readonly allowances: {
    readonly recordAcceptedMessage: (receipt: AcceptanceReceipt) => Effect.Effect<void, Failure>;
  };
  readonly onboarding: {
    readonly handle: (
      command: WhatsAppOnboardingCommand,
    ) => Effect.Effect<{ readonly _tag: string }, Failure>;
  };
  readonly persistence: {
    readonly admit: (
      route: Extract<InboundRoute, { readonly _tag: "Bound" }>,
    ) => Effect.Effect<AuthorizationContext, Failure>;
    readonly route: (input: RouteInput) => Effect.Effect<InboundRoute, Failure>;
  };
}

/** Inbound admission operations exposed to an authenticated HTTP adapter. */
export interface Service<Failure> {
  readonly admit: (
    message: InboundWhatsAppMessage,
  ) => Effect.Effect<AdmissionOutcome, Failure | WhatsAppIdentityUnavailable>;
}

/** Construct inbound admission from caller-shaped provider, Agent, and persistence ports. */
export const make = <Failure>(options: Interface<Failure>): Service<Failure> => ({
  admit: (
    message: InboundWhatsAppMessage,
  ): Effect.Effect<AdmissionOutcome, Failure | WhatsAppIdentityUnavailable> =>
    Effect.gen(function* () {
      const contentDigest = yield* digest(
        encodeIdentity([
          message._tag,
          message.channelIdentity,
          message.phoneNumberId,
          message.providerMessageId,
          message.message,
        ]),
      );
      const route = yield* options.persistence.route({ ...message, contentDigest });
      if (route._tag === "Unbound") {
        yield* options.onboarding.handle(onboardingCommand(message));
        return { _tag: "OnboardingAccepted" } as const;
      }
      const identityDigest = yield* digest(
        encodeIdentity([route.channelBindingId, message.providerMessageId]),
      );
      const recoveryInput = AgentRecoveryInput.make({
        channelBindingId: route.channelBindingId,
        providerMessageId: message.providerMessageId,
        receiptId: AcceptanceReceiptId.make(`receipt-${identityDigest}`),
        submissionId: ThinkSubmissionId.make(`submission-${identityDigest}`),
        userMessageId: UserMessageId.make(`message-${identityDigest}`),
      });
      const recovered = yield* options.agent.recover(route.agentId, recoveryInput);
      if (recovered !== null) {
        yield* options.allowances.recordAcceptedMessage(recovered);
        return { _tag: "MessageAccepted", receipt: recovered } as const;
      }
      const authorization = yield* options.persistence.admit(route);
      const receipt = yield* options.agent.accept(route.agentId, {
        ...recoveryInput,
        authorization,
        message: message.message,
      });
      if (Predicate.isTagged(receipt, "ManagedConversationDenied")) {
        return { _tag: "MessageDenied", reason: receipt.reason } as const;
      }
      yield* options.allowances.recordAcceptedMessage(receipt);
      return { _tag: "MessageAccepted", receipt } as const;
    }),
});

const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const onboardingCommand = (message: InboundWhatsAppMessage): WhatsAppOnboardingCommand => {
  const enrollment = /^OSFO ENROLL (\S+)$/u.exec(message.message.trim());
  const token = Schema.decodeUnknownOption(RegistrationToken)(enrollment?.[1]);
  return Option.isNone(token)
    ? {
        _tag: "UnknownSenderMessage",
        channelIdentity: message.channelIdentity,
        eventId: `${message.phoneNumberId}:${message.providerMessageId}`,
        invitedPhoneNumber: message.channelIdentity,
        locale: "en",
        message: message.message,
      }
    : {
        _tag: "EnrollmentControlMessage",
        channelIdentity: message.channelIdentity,
        eventId: `${message.phoneNumberId}:${message.providerMessageId}`,
        token: Redacted.make(token.value),
      };
};

const digest = (value: string): Effect.Effect<string, WhatsAppIdentityUnavailable> =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    catch: (cause) =>
      new WhatsAppIdentityUnavailable({
        cause,
        message: "Stable WhatsApp admission identities could not be derived",
      }),
  }).pipe(
    Effect.map((bytes) =>
      Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 40),
    ),
  );
