import { Crypto, Effect, Layer, Schema } from "effect";

import { ManagedConversationDenied } from "../../services/managed-conversation";
import * as MessagingAdmission from "../../services/messaging-admission";
import { AcceptanceReceipt } from "../../services/provider-acceptance-receipt";
import type * as ProviderAdmission from "../../services/provider-message-admission";

/* oxlint-disable eslint/no-underscore-dangle -- Effect schemas use the standard _tag discriminator. */

type AgentResult = AcceptanceReceipt | ManagedConversationDenied | { readonly _tag: string };

interface AgentStub {
  readonly acceptTelegramMessage: (
    input: ProviderAdmission.AgentAcceptanceInput,
  ) => Promise<AgentResult>;
  readonly recoverTelegramMessage: (
    input: ProviderAdmission.AgentRecoveryInput,
  ) => Promise<AgentResult | null>;
}

/** Cloudflare binding required to address the stable named Osfo Agent. */
export interface Bindings {
  readonly OSFO_AGENT: { readonly getByName: (identity: string) => AgentStub };
}

/** Named-Agent RPC and stable Web Crypto identities for Telegram admission. */
export const layer = (env: Bindings) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      return Layer.merge(
        Layer.succeed(
          MessagingAdmission.AgentSubmission,
          MessagingAdmission.AgentSubmission.of({
            accept: (agentId, input) =>
              Effect.tryPromise({
                try: () => env.OSFO_AGENT.getByName(agentId).acceptTelegramMessage(input),
                catch: (cause) => unavailable("acceptTelegramMessage", cause),
              }).pipe(Effect.flatMap(decodeAcceptance)),
            recover: (agentId, input) =>
              Effect.tryPromise({
                try: () => env.OSFO_AGENT.getByName(agentId).recoverTelegramMessage(input),
                catch: (cause) => unavailable("recoverTelegramMessage", cause),
              }).pipe(
                Effect.flatMap((result) =>
                  result === null ? Effect.succeed(null) : decodeReceipt(result),
                ),
              ),
          }),
        ),
        Layer.succeed(
          MessagingAdmission.StableIdentity,
          MessagingAdmission.StableIdentity.of({
            deriveAdmission: (route, providerMessageId) =>
              digest(crypto, [route.channelBindingId, providerMessageId]),
            deriveContent: (input) =>
              digest(crypto, [input.channelIdentity, input.eventId, input.message]),
          }),
        ),
      );
    }),
  );

const decodeAcceptance = (
  result: AgentResult,
): Effect.Effect<
  AcceptanceReceipt | ManagedConversationDenied,
  MessagingAdmission.MessagingAdmissionUnavailable
> =>
  result._tag === "AcceptanceReceipt"
    ? decodeReceipt(result)
    : result._tag === "ManagedConversationDenied"
      ? Schema.decodeUnknownEffect(ManagedConversationDenied)(result).pipe(
          Effect.mapError((cause) => unavailable("decodeAgentAcceptance", cause)),
        )
      : Effect.fail(unavailable("decodeAgentAcceptance", result));

const decodeReceipt = (result: AgentResult) =>
  Schema.decodeUnknownEffect(AcceptanceReceipt)(result).pipe(
    Effect.mapError((cause) => unavailable("decodeAgentReceipt", cause)),
  );

const digest = (crypto: Crypto.Crypto, values: ReadonlyArray<string>) =>
  crypto.digest("SHA-256", new TextEncoder().encode(JSON.stringify(values))).pipe(
    Effect.map((bytes) =>
      Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 40),
    ),
    Effect.mapError((cause) => unavailable("deriveStableIdentity", cause)),
  );

const unavailable = (operation: string, cause: unknown) =>
  new MessagingAdmission.MessagingAdmissionUnavailable({
    cause,
    message: "The stable Osfo Agent could not accept the Telegram message",
    operation,
  });
