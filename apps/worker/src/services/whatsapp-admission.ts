import { Option, Redacted, Schema } from "effect";
import type { Effect } from "effect";
import { RegistrationToken } from "@osfo/api";

import {
  AcceptanceReceiptId,
  type AgentId,
  ChannelBindingId,
  ProviderMessageId,
  ThinkSubmissionId,
  UserMessageId,
} from "../domain";
import type { AcceptanceReceipt } from "./whatsapp-acceptance-receipt";
import type { AuthorizationDenialReason } from "./authorization";
import type { ManagedConversationDenied } from "./managed-conversation";
import type { WhatsAppOnboardingCommand } from "./whatsapp-onboarding";
import * as ProviderAdmission from "./provider-message-admission";

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

/** Meta phone-number resource identity accepted by inbound routing. */
export type WhatsAppPhoneNumberId = typeof WhatsAppPhoneNumberId.Type;

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

/** Truncated SHA-256 digest of authenticated provider message content. */
export const WhatsAppProviderContentDigest = Schema.String.check(
  Schema.isMinLength(40),
  Schema.isMaxLength(40),
  Schema.isPattern(/^[0-9a-f]+$/u),
).pipe(Schema.brand("WhatsAppProviderContentDigest"));

/** Truncated SHA-256 digest of the stable WhatsApp admission identity chain. */
export const WhatsAppAdmissionIdentityDigest = Schema.String.check(
  Schema.isMinLength(40),
  Schema.isMaxLength(40),
  Schema.isPattern(/^[0-9a-f]+$/u),
).pipe(Schema.brand("WhatsAppAdmissionIdentityDigest"));

/** Provider-event facts fixed before Channel Binding resolution. */
export type RouteInput = InboundWhatsAppMessage & {
  readonly contentDigest: typeof WhatsAppProviderContentDigest.Type;
};

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
  message: WhatsAppMessageText,
});

/** Stable facts sent to the named Agent acceptance RPC. */
export type AgentAcceptanceInput = typeof AgentAcceptanceInput.Type;

/** Observable inbound result used by the HTTP webhook boundary. */
export type AdmissionOutcome =
  | { readonly _tag: "MessageAccepted"; readonly receipt: AcceptanceReceipt }
  | { readonly _tag: "MessageDenied"; readonly reason: AuthorizationDenialReason }
  | { readonly _tag: "OnboardingAccepted" };

/** Dependencies required by WhatsApp inbound admission policy. */
export interface Interface<Failure> {
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
  readonly identity: WhatsAppStableIdentity;
  readonly onboarding: {
    readonly handle: (command: WhatsAppOnboardingCommand) => Effect.Effect<void, Failure>;
  };
  readonly persistence: {
    readonly admit: (
      route: Extract<InboundRoute, { readonly _tag: "Bound" }>,
    ) => Effect.Effect<void, Failure>;
    readonly route: (input: RouteInput) => Effect.Effect<InboundRoute, Failure>;
  };
}

/** Stable identity derivation required by inbound WhatsApp admission. */
export interface WhatsAppStableIdentity {
  readonly deriveAdmission: (
    route: Extract<InboundRoute, { readonly _tag: "Bound" }>,
    providerMessageId: ProviderMessageId,
  ) => Effect.Effect<typeof WhatsAppAdmissionIdentityDigest.Type, WhatsAppIdentityUnavailable>;
  readonly deriveContent: (
    message: InboundWhatsAppMessage,
  ) => Effect.Effect<typeof WhatsAppProviderContentDigest.Type, WhatsAppIdentityUnavailable>;
}

/** Inbound admission operations exposed to an authenticated HTTP adapter. */
export interface Service<Failure> {
  readonly admit: (
    message: InboundWhatsAppMessage,
  ) => Effect.Effect<AdmissionOutcome, Failure | WhatsAppIdentityUnavailable>;
}

/** Construct inbound admission from caller-shaped provider, Agent, and persistence ports. */
export const make = <Failure>(options: Interface<Failure>): Service<Failure> => ({
  admit: ProviderAdmission.make({
    agent: {
      accept: (agentId, input) =>
        options.agent.accept(
          agentId,
          AgentAcceptanceInput.make({ ...input, message: WhatsAppMessageText.make(input.message) }),
        ),
      recover: (agentId, input) => options.agent.recover(agentId, AgentRecoveryInput.make(input)),
    },
    allowances: options.allowances,
    identity: options.identity,
    message: (message: InboundWhatsAppMessage) => ({
      providerMessageId: message.providerMessageId,
      text: message.message,
    }),
    onboarding: (message: InboundWhatsAppMessage) =>
      options.onboarding.handle(onboardingCommand(message)),
    persistence: options.persistence,
    routeInput: (message: InboundWhatsAppMessage, contentDigest: string): RouteInput => ({
      ...message,
      contentDigest: WhatsAppProviderContentDigest.make(contentDigest),
    }),
  }).admit,
});

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
