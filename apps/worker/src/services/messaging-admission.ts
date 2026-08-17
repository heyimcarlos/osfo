import { Context, Effect, Layer, Schema } from "effect";

import { ChannelIdentity, ProviderMessageId } from "../domain";
import type { AgentId } from "../domain";
import type { ManagedConversationDenied } from "./managed-conversation";
import type { AcceptanceReceipt } from "./provider-acceptance-receipt";
import * as ProviderAdmission from "./provider-message-admission";

/* oxlint-disable eslint/no-underscore-dangle -- Effect schemas use the standard _tag discriminator. */

/** Telegram-authenticated text fixed before routing or Agent admission. */
export const TelegramMessageAdmissionInput = Schema.Struct({
  channelIdentity: ChannelIdentity,
  eventId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000)),
});
/** Authenticated Telegram message accepted at the application boundary. */
export type TelegramMessageAdmissionInput = typeof TelegramMessageAdmissionInput.Type;

/** Immutable provider facts used to resolve one Telegram event's first route. */
export interface TelegramRouteInput extends TelegramMessageAdmissionInput {
  readonly contentDigest: string;
  readonly providerMessageId: ProviderMessageId;
}

/** Telegram route fixed to one current Channel Binding and stable Agent. */
export type BoundChannel = Extract<ProviderAdmission.InboundRoute, { readonly _tag: "Bound" }>;

/** Expected failure while routing, recording, or submitting a Telegram message. */
export class MessagingAdmissionUnavailable extends Schema.TaggedError<MessagingAdmissionUnavailable>()(
  "MessagingAdmissionUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

/** Persistence needed to fix a Telegram route and record accepted-message usage. */
export interface PersistencePort {
  readonly admit: (route: BoundChannel) => Effect.Effect<void, MessagingAdmissionUnavailable>;
  readonly recordAccepted: (
    receipt: AcceptanceReceipt,
  ) => Effect.Effect<void, MessagingAdmissionUnavailable>;
  readonly route: (
    input: TelegramRouteInput,
  ) => Effect.Effect<ProviderAdmission.InboundRoute, MessagingAdmissionUnavailable>;
}

/** Effect service for Telegram event routing and accepted-message usage. */
export class Persistence extends Context.Service<Persistence, PersistencePort>()(
  "@osfo/TelegramAdmission/Persistence",
) {}

/** Stable named-Agent operations used by Telegram admission. */
export interface AgentAdmissionPort {
  readonly accept: (
    agentId: AgentId,
    input: ProviderAdmission.AgentAcceptanceInput,
  ) => Effect.Effect<AcceptanceReceipt | ManagedConversationDenied, MessagingAdmissionUnavailable>;
  readonly recover: (
    agentId: AgentId,
    input: ProviderAdmission.AgentRecoveryInput,
  ) => Effect.Effect<AcceptanceReceipt | null, MessagingAdmissionUnavailable>;
}

/** Effect service for recoverable Telegram submission to the named Agent. */
export class AgentSubmission extends Context.Service<AgentSubmission, AgentAdmissionPort>()(
  "@osfo/TelegramAdmission/Agent",
) {}

/** Stable digest derivation needed for provider-event and Agent idempotency. */
export interface StableIdentityPort {
  readonly deriveAdmission: (
    route: BoundChannel,
    providerMessageId: ProviderMessageId,
  ) => Effect.Effect<string, MessagingAdmissionUnavailable>;
  readonly deriveContent: (
    input: TelegramMessageAdmissionInput,
  ) => Effect.Effect<string, MessagingAdmissionUnavailable>;
}

/** Effect service for Telegram content and admission identity derivation. */
export class StableIdentity extends Context.Service<StableIdentity, StableIdentityPort>()(
  "@osfo/TelegramAdmission/Identity",
) {}

/** Public Telegram admission outcome projected for the webhook handler. */
export type AdmissionResult =
  | { readonly _tag: "Accepted" }
  | { readonly _tag: "Denied" }
  | { readonly _tag: "Unbound" };

/** Application operation that admits one authenticated Telegram message. */
export interface Interface {
  readonly accept: (
    input: TelegramMessageAdmissionInput,
  ) => Effect.Effect<AdmissionResult, MessagingAdmissionUnavailable>;
}

/** Telegram admission application service. */
export class Service extends Context.Service<Service, Interface>()("@osfo/TelegramAdmission") {}

/** Build Telegram admission on the same immutable route/Agent receipt seam as WhatsApp. */
export const make = Effect.gen(function* () {
  const agent = yield* AgentSubmission;
  const identity = yield* StableIdentity;
  const persistence = yield* Persistence;
  const admission = ProviderAdmission.make({
    agent,
    allowances: { recordAcceptedMessage: persistence.recordAccepted },
    identity,
    message: (input: TelegramMessageAdmissionInput) => ({
      providerMessageId: ProviderMessageId.make(input.eventId),
      text: input.message,
    }),
    onboarding: () => Effect.void,
    persistence,
    routeInput: (input: TelegramMessageAdmissionInput, contentDigest: string) => ({
      ...input,
      contentDigest,
      providerMessageId: ProviderMessageId.make(input.eventId),
    }),
  });
  return Service.of({
    accept: (input) =>
      admission
        .admit(input)
        .pipe(
          Effect.map((outcome): AdmissionResult =>
            outcome._tag === "MessageAccepted"
              ? { _tag: "Accepted" }
              : outcome._tag === "MessageDenied"
                ? { _tag: "Denied" }
                : { _tag: "Unbound" },
          ),
        ),
  });
});

/** Telegram admission layer awaiting its Agent, identity, and persistence adapters. */
export const layerWithoutDependencies = Layer.effect(Service, make);
