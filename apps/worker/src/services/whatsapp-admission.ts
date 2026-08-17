import { Effect, Option, Predicate, Redacted, Schema } from "effect";
import { RegistrationToken } from "@osfo/api";

import {
  AcceptanceReceiptId,
  type AgentId,
  type ChannelBindingId,
  type ChannelIdentity,
  type ProviderMessageId,
  ThinkSubmissionId,
  UserMessageId,
} from "../domain";
import type { AuthorizationContext } from "./authorization";
import type { AcceptanceReceipt } from "./whatsapp-acceptance-receipt";
import type { WhatsAppOnboardingCommand } from "./whatsapp-onboarding";

/* oxlint-disable eslint/no-underscore-dangle -- Effect schemas use the standard _tag discriminator. */

/** Supported direct-message facts produced by the authenticated Meta adapter. */
export type InboundWhatsAppMessage =
  | {
      readonly _tag: "ButtonReply";
      readonly channelIdentity: ChannelIdentity;
      readonly message: string;
      readonly phoneNumberId: string;
      readonly providerMessageId: ProviderMessageId;
    }
  | {
      readonly _tag: "TextMessage";
      readonly channelIdentity: ChannelIdentity;
      readonly message: string;
      readonly phoneNumberId: string;
      readonly providerMessageId: ProviderMessageId;
    };

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
      readonly authorization: AuthorizationContext;
      readonly channelBindingId: ChannelBindingId;
    }
  | { readonly _tag: "Unbound" };

/** Stable facts sent to the named Agent acceptance RPC. */
export interface AgentAcceptanceInput {
  readonly authorization: AuthorizationContext;
  readonly channelBindingId: ChannelBindingId;
  readonly message: string;
  readonly providerMessageId: ProviderMessageId;
  readonly receiptId: AcceptanceReceiptId;
  readonly submissionId: ThinkSubmissionId;
  readonly userMessageId: UserMessageId;
}

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
      const receipt = yield* options.agent.accept(route.agentId, {
        authorization: route.authorization,
        channelBindingId: route.channelBindingId,
        message: message.message,
        providerMessageId: message.providerMessageId,
        receiptId: AcceptanceReceiptId.make(`receipt-${identityDigest}`),
        submissionId: ThinkSubmissionId.make(`submission-${identityDigest}`),
        userMessageId: UserMessageId.make(`message-${identityDigest}`),
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
