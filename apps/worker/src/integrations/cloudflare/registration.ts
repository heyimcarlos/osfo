import { Effect, Layer, Schema } from "effect";

import { OSFO_DIRECTORY_NAME } from "../../agents/osfo/identity";
import { AgentInitializationId, ConversationRouteId, SessionId } from "../../domain";
import { Registration } from "../../services/registration";

/* oxlint-disable eslint/no-underscore-dangle, typescript/consistent-return -- Cloudflare RPC results use tagged Effect values, and a typed failure exits initialization. */

const RpcResult = Schema.StructWithRest(Schema.Struct({ _tag: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);

interface DirectoryRegistrationStub {
  readonly ensureAgent: (
    agentId: string,
  ) => Promise<{ readonly className: string; readonly name: string }>;
  readonly initializeAgent: (
    agentId: string,
    input: {
      readonly agentId: string;
      readonly initializationId: string;
      readonly initializedAt: string;
      readonly routeId: string;
      readonly sessionId: string;
    },
  ) => Promise<{ readonly _tag: string }>;
}

interface DurableNamespace<Stub> {
  readonly getByName: (identity: string) => Stub;
}

export interface Bindings {
  readonly OSFO_DIRECTORY: DurableNamespace<DirectoryRegistrationStub>;
}

/** Initialize the stable User Agent facet after PostgreSQL registration commits. */
export const layer = (env: Bindings) =>
  Layer.succeed(
    Registration.AgentRegistration,
    Registration.AgentRegistration.of({
      initialize: Effect.fn("AgentRegistration.initialize")(function* (registration) {
        const agentId = registration.agentId;
        const directory = env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
        yield* Effect.tryPromise({
          try: () => directory.ensureAgent(agentId),
          catch: (cause) => unavailable("The personal Agent facet could not be created", cause),
        });
        const result = yield* Effect.tryPromise({
          try: () =>
            directory.initializeAgent(agentId, {
              agentId,
              initializationId: AgentInitializationId.make(`registration-${agentId}`),
              initializedAt: registration.completedAt.toISOString(),
              routeId: ConversationRouteId.make(`primary-route-${agentId}`),
              sessionId: SessionId.make(`primary-session-${agentId}`),
            }),
          catch: (cause) => unavailable("The personal Agent could not be initialized", cause),
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(RpcResult)),
          Effect.mapError((cause) =>
            unavailable("The personal Agent could not be initialized", cause),
          ),
        );
        if (result._tag !== "AgentInitialized") {
          return yield* unavailable(
            "The personal Agent rejected its stable initialization",
            result,
          );
        }
      }),
    }),
  );

const unavailable = (message: string, cause: unknown) =>
  new Registration.RegistrationAgentUnavailable({ cause, message });

export * as RegistrationCloudflare from "./registration";
