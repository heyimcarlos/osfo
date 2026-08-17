import { DateTime, Effect, Predicate, Schema } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

import { database } from "../db";
import * as Billing from "../db/billing";
import { retainedCatalog } from "../domain/plan-policy";
import type { RuntimeConfig } from "../env";
import { handleWhatsAppOnboardingCommand } from "./whatsapp-onboarding";
import {
  authenticateAndDecode,
  type MetaInboundFact,
  verifyChallenge,
} from "../integrations/meta/whatsapp";
import * as WhatsAppPostgres from "../integrations/postgres/whatsapp-admission";
import * as Allowances from "../services/allowances";
import * as Onboarding from "../services/onboarding";
import { AcceptanceReceipt } from "../services/whatsapp-acceptance-receipt";
import * as WhatsAppAdmission from "../services/whatsapp-admission";

/* oxlint-disable eslint/no-underscore-dangle -- Effect schemas and RPC values use the standard _tag discriminator. */

const ManagedConversationDenied = Schema.TaggedStruct("ManagedConversationDenied", {
  reason: Schema.String,
});
const AgentRpcTag = Schema.Struct({ _tag: Schema.String });

type AgentAcceptanceRpcResult =
  | AcceptanceReceipt
  | typeof ManagedConversationDenied.Type
  | { readonly _tag: string };

interface WhatsAppAgentStub {
  readonly acceptWhatsAppMessage: (
    input: WhatsAppAdmission.AgentAcceptanceInput,
  ) => Promise<AgentAcceptanceRpcResult>;
}

/** Cloudflare binding needed for direct named-Agent admission. */
export interface Bindings {
  readonly OSFO_AGENT: {
    readonly getByName: (agentId: string) => WhatsAppAgentStub;
  };
}

/** Install authenticated Meta verification and inbound event routes. */
export const layer = (options: { readonly config: RuntimeConfig; readonly env: Bindings }) => {
  const handler = Effect.gen(function* () {
    const db = yield* database;
    const onboarding = yield* Onboarding.Service;
    const now = DateTime.toDateUtc(yield* DateTime.now);
    const persistence = yield* WhatsAppPostgres.make({ now: Effect.succeed(now) });
    const allowances = Allowances.make({
      billing: Billing.make(db),
      catalog: retainedCatalog,
      now: Effect.succeed(now),
    });
    const admission = WhatsAppAdmission.make({
      agent: {
        accept: (agentId, input) =>
          Effect.tryPromise({
            try: () => options.env.OSFO_AGENT.getByName(agentId).acceptWhatsAppMessage(input),
            catch: (cause) =>
              new WhatsAppAdmission.WhatsAppAdmissionUnavailable({
                cause,
                message: "The named Agent could not accept the WhatsApp message",
              }),
          }).pipe(Effect.flatMap(decodeAgentAcceptance)),
      },
      allowances: {
        recordAcceptedMessage: (receipt) =>
          allowances
            .record(
              receipt.allowancePeriodId,
              { sourceId: receipt.receiptId, sourceType: "acceptanceReceipt" },
              [{ allowanceKind: "acceptedMessages", basis: "known_at_start", quantity: 1n }],
            )
            .pipe(
              Effect.asVoid,
              Effect.mapError(
                (cause) =>
                  new WhatsAppAdmission.WhatsAppAdmissionUnavailable({
                    cause,
                    message: "Accepted WhatsApp use could not be recorded",
                  }),
              ),
            ),
      },
      onboarding: {
        handle: (command) =>
          handleWhatsAppOnboardingCommand(onboarding, command).pipe(
            Effect.mapError(
              (cause) =>
                new WhatsAppAdmission.WhatsAppAdmissionUnavailable({
                  cause,
                  message: "WhatsApp onboarding could not be completed",
                }),
            ),
          ),
      },
      persistence: {
        route: (input) =>
          persistence.route(input).pipe(
            Effect.mapError(
              (cause) =>
                new WhatsAppAdmission.WhatsAppAdmissionUnavailable({
                  cause,
                  message: "The inbound WhatsApp route could not be recovered",
                }),
            ),
          ),
      },
    });

    const runRequest = (request: Request) => {
      // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- boundary: WebHandler requires a Promise and handleRequest has no Effect services.
      return Effect.runPromise(handleRequest(request, options.config, admission));
    };
    return yield* HttpEffect.fromWebHandler(runRequest);
  });
  return HttpRouter.add("*", "/webhooks/whatsapp", handler);
};

const handleRequest = (
  request: Request,
  config: RuntimeConfig,
  admission: WhatsAppAdmission.Service<WhatsAppAdmission.WhatsAppAdmissionUnavailable>,
): Effect.Effect<Response> => {
  if (request.method === "GET") {
    const verified = verifyChallenge(new URL(request.url), config.meta.webhookVerifyToken);
    return Effect.succeed(
      Predicate.isTagged(verified, "ChallengeVerified")
        ? new Response(verified.challenge, { status: 200 })
        : new Response("Forbidden", { status: 403 }),
    );
  }
  if (request.method !== "POST") return Effect.succeed(new Response("Not found", { status: 404 }));

  return authenticateAndDecode(request, config.meta.appSecret).pipe(
    Effect.flatMap((facts) =>
      Effect.forEach(facts, (fact) => admitFact(admission, fact), { discard: true }),
    ),
    Effect.as(new Response("EVENT_RECEIVED", { status: 200 })),
    Effect.catch((error) =>
      Effect.succeed(
        Predicate.isTagged(error, "MetaWebhookAuthenticationFailed")
          ? new Response("Unauthorized", { status: 401 })
          : Predicate.isTagged(error, "MetaWebhookPayloadInvalid")
            ? new Response("Bad request", { status: 400 })
            : new Response("Temporarily unavailable", { status: 503 }),
      ),
    ),
  );
};

const admitFact = (
  admission: WhatsAppAdmission.Service<WhatsAppAdmission.WhatsAppAdmissionUnavailable>,
  fact: MetaInboundFact,
) =>
  fact._tag === "TextMessage" || fact._tag === "ButtonReply"
    ? admission.admit(fact).pipe(Effect.asVoid)
    : Effect.void;

const decodeAgentAcceptance = (
  result: AgentAcceptanceRpcResult,
): Effect.Effect<
  AcceptanceReceipt | typeof ManagedConversationDenied.Type,
  WhatsAppAdmission.WhatsAppAdmissionUnavailable
> =>
  Schema.decodeEffect(AgentRpcTag)(result).pipe(
    Effect.mapError(
      (cause) =>
        new WhatsAppAdmission.WhatsAppAdmissionUnavailable({
          cause,
          message: "The named Agent returned an invalid acceptance result",
        }),
    ),
    Effect.flatMap((tag) => {
      const schema =
        tag._tag === "AcceptanceReceipt"
          ? AcceptanceReceipt
          : tag._tag === "ManagedConversationDenied"
            ? ManagedConversationDenied
            : null;
      return schema === null
        ? Effect.fail(
            new WhatsAppAdmission.WhatsAppAdmissionUnavailable({
              cause: result,
              message: "The named Agent could not recover WhatsApp acceptance",
            }),
          )
        : Schema.decodeUnknownEffect(schema)(result).pipe(
            Effect.mapError(
              (cause) =>
                new WhatsAppAdmission.WhatsAppAdmissionUnavailable({
                  cause,
                  message: "The named Agent returned invalid acceptance facts",
                }),
            ),
          );
    }),
  );
