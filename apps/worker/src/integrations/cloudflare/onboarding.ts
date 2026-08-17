import { Effect, Layer, Schema } from "effect";

import { AgentInitializationId, ConversationRouteId, SessionId } from "../../domain";
import * as Onboarding from "../../services/onboarding";

/* oxlint-disable eslint/no-underscore-dangle -- Cloudflare and Effect RPC results use the standard _tag discriminator. */

const RpcResult = Schema.StructWithRest(Schema.Struct({ _tag: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);

const RegistrationResult = Schema.Union([
  Schema.TaggedStruct("RegistrationTurnCompleted", {
    response: Schema.String,
    verifyUrl: Schema.String,
  }),
  Schema.TaggedStruct("RegistrationTurnUnavailable", { message: Schema.String }),
]);

interface AgentOnboardingStub {
  readonly initialize: (input: {
    readonly agentId: string;
    readonly initializationId: string;
    readonly initializedAt: string;
    readonly routeId: string;
    readonly sessionId: string;
  }) => Promise<TaggedRpcResult>;
  readonly commitWelcome: (input: {
    readonly channelBindingId: string;
    readonly helpAreas: ReadonlyArray<Onboarding.HelpArea>;
    readonly locale: Onboarding.OnboardingLocale;
    readonly preferredName: string | null;
  }) => Promise<TaggedRpcResult>;
}

interface TaggedRpcResult {
  readonly _tag: string;
}

interface RegistrationDialogueStub {
  readonly begin: (input: {
    readonly eventId: string;
    readonly locale: Onboarding.OnboardingLocale;
    readonly message: string;
    readonly verifyUrl: string;
  }) => Promise<RegistrationTurnRpcResult>;
  readonly deleteDialogue: () => Promise<void>;
}

type RegistrationTurnRpcResult =
  | {
      readonly _tag: "RegistrationTurnCompleted";
      readonly response: string;
      readonly verifyUrl: string;
    }
  | { readonly _tag: "RegistrationTurnUnavailable"; readonly message: string };

interface DurableNamespace<Stub> {
  readonly getByName: (identity: string) => Stub;
}

/** Cloudflare Durable Object bindings used by onboarding application ports. */
export interface Bindings {
  readonly OSFO_AGENT: DurableNamespace<AgentOnboardingStub>;
  readonly REGISTRATION_DIALOGUE: DurableNamespace<RegistrationDialogueStub>;
}

/** Implement narrow onboarding ports through stable named Durable Object RPC. */
export const layer = (env: Bindings) =>
  Layer.merge(
    Layer.succeed(
      Onboarding.AgentOnboarding,
      Onboarding.AgentOnboarding.of({
        initialize: (input) => {
          const agentId = input.agentId;
          const initializeWithRoute = (routeId: ConversationRouteId) =>
            call(
              () =>
                env.OSFO_AGENT.getByName(agentId).initialize({
                  agentId,
                  initializationId: AgentInitializationId.make(`registration-${agentId}`),
                  initializedAt: input.completedAt.toISOString(),
                  routeId,
                  sessionId: SessionId.make(`primary-session-${agentId}`),
                }),
              "The personal Agent could not be initialized",
            );
          return initializeWithRoute(ConversationRouteId.make(`primary-route-${agentId}`)).pipe(
            Effect.flatMap((result) => {
              if (result._tag === "AgentInitialized") return Effect.void;
              if (result._tag !== "AgentInitializationConflict") {
                return unavailable("The personal Agent rejected its stable initialization", result);
              }
              return initializeWithRoute(
                ConversationRouteId.make(`whatsapp-route-${agentId}`),
              ).pipe(
                Effect.flatMap((legacyResult) =>
                  legacyResult._tag === "AgentInitialized"
                    ? Effect.void
                    : unavailable(
                        "The personal Agent rejected its legacy stable initialization",
                        legacyResult,
                      ),
                ),
              );
            }),
          );
        },
        commitWelcome: (input) =>
          call(
            () =>
              env.OSFO_AGENT.getByName(input.agentId).commitWelcome({
                channelBindingId: input.channelBindingId,
                helpAreas: input.profile.helpAreas,
                locale: input.profile.locale,
                preferredName: input.profile.preferredName,
              }),
            "The personal welcome could not be committed",
          ).pipe(
            Effect.flatMap((result) =>
              result._tag === "PersonalWelcomeCommitted"
                ? Effect.void
                : unavailable("The personal Agent rejected its welcome", result),
            ),
          ),
      }),
    ),
    Layer.succeed(
      Onboarding.RegistrationTurn,
      Onboarding.RegistrationTurn.of({
        begin: (input) =>
          Effect.tryPromise({
            try: () =>
              env.REGISTRATION_DIALOGUE.getByName(input.invitationId).begin({
                eventId: input.eventId,
                locale: input.locale,
                message: input.message,
                verifyUrl: input.verifyUrl,
              }),
            catch: (cause) => executionUnavailable("The Registration Turn is unavailable", cause),
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(RegistrationResult)),
            Effect.mapError((cause) => executionUnavailable("The Registration Turn failed", cause)),
            Effect.flatMap((result) =>
              result._tag === "RegistrationTurnCompleted"
                ? Effect.succeed({ response: result.response, verifyUrl: result.verifyUrl })
                : unavailable(result.message, result),
            ),
          ),
        delete: (invitationId) =>
          Effect.tryPromise({
            try: () => env.REGISTRATION_DIALOGUE.getByName(invitationId).deleteDialogue(),
            catch: (cause) =>
              executionUnavailable("The Registration Dialogue could not be deleted", cause),
          }),
      }),
    ),
  );

const call = (invoke: () => Promise<TaggedRpcResult>, message: string) =>
  Effect.tryPromise({
    try: invoke,
    catch: (cause) => executionUnavailable(message, cause),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(RpcResult)),
    Effect.mapError((cause) => executionUnavailable(message, cause)),
  );

const unavailable = (message: string, cause: unknown) =>
  Effect.fail(executionUnavailable(message, cause));

const executionUnavailable = (message: string, cause: unknown) =>
  new Onboarding.OnboardingExecutionUnavailable({ cause, message });
