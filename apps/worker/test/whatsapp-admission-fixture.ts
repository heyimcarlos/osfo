import { Effect, Schema } from "effect";

import { type AllowancePeriodId, SessionId } from "../src/domain";
import { AcceptanceReceipt } from "../src/services/whatsapp-acceptance-receipt";
import {
  type AgentAcceptanceInput,
  type AgentRecoveryInput,
  InboundWhatsAppMessage,
  type Interface,
  make as makeAdmission,
} from "../src/services/whatsapp-admission";

type AcceptanceOutcome =
  | AcceptanceReceipt
  | { readonly _tag: "ManagedConversationDenied"; readonly reason: string };

interface AdmissionFixtureOptions<Failure> {
  readonly accept: (input: AgentAcceptanceInput) => Effect.Effect<AcceptanceOutcome>;
  readonly persistence: Interface<Failure>["persistence"];
  readonly recordAcceptedMessage: Interface<Failure>["allowances"]["recordAcceptedMessage"];
  readonly recover?:
    | ((input: AgentRecoveryInput) => Effect.Effect<AcceptanceReceipt | null>)
    | undefined;
}

/** Compose the shared WhatsApp admission contract around an engine-owned persistence fixture. */
export const makeWhatsAppAdmissionFixture = <Failure>(options: AdmissionFixtureOptions<Failure>) =>
  makeAdmission<Failure>({
    agent: {
      accept: (_agentId, input) => options.accept(input),
      recover: (_agentId, input) => options.recover?.(input) ?? Effect.succeed(null),
    },
    allowances: { recordAcceptedMessage: options.recordAcceptedMessage },
    onboarding: { handle: () => Effect.succeed({ _tag: "OnboardingAccepted" }) },
    persistence: options.persistence,
  });

/** Build the durable receipt returned for one accepted Agent input. */
export const receiptFromAcceptance = (
  input: AgentAcceptanceInput,
  allowancePeriodId: AllowancePeriodId,
): AcceptanceReceipt =>
  Schema.decodeSync(AcceptanceReceipt)({
    _tag: "AcceptanceReceipt",
    acceptedAt: "2026-08-16T12:00:00Z",
    allowancePeriodId,
    channelBindingId: input.channelBindingId,
    providerMessageId: input.providerMessageId,
    receiptId: input.receiptId,
    sessionId: SessionId.make(`session-${input.submissionId}`),
    thinkSubmissionId: input.submissionId,
    userMessageId: input.userMessageId,
  });

/** Build the durable receipt recovered from stable Agent recovery identities. */
export const recoveredReceipt = (
  input: AgentRecoveryInput,
  allowancePeriodId: AllowancePeriodId,
  acceptedAt: string,
): AcceptanceReceipt =>
  Schema.decodeSync(AcceptanceReceipt)({
    ...input,
    _tag: "AcceptanceReceipt",
    acceptedAt,
    allowancePeriodId,
    sessionId: SessionId.make(`session-${input.submissionId}`),
    thinkSubmissionId: input.submissionId,
  });

/** Build the supported direct-message fact shared by both PostgreSQL engines. */
export const routeMessage = (channelIdentity: string, providerMessageId: string) =>
  Schema.decodeSync(InboundWhatsAppMessage)({
    _tag: "TextMessage",
    channelIdentity,
    message: "Please help",
    phoneNumberId: "123456789",
    providerMessageId,
  });
