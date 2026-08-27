/* oxlint-disable osfo/no-unknown-parameters -- This handler owns the Cloudflare RPC trust boundary. */

import {
  Api,
  CurrentUser,
  IntegrationConnectionChanged,
  IntegrationConnectionSummary,
  IntegrationConnectRedirect,
  IntegrationsUnavailable,
  type IntegrationToolkit,
} from "@osfo/api";
import { Effect, Layer, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { UserId } from "../domain";
import { AgentDirectory } from "../services/agent-directory";

interface Actor {
  readonly authSessionId: string;
  readonly userId: string;
}

interface IntegrationsDirectoryStub {
  readonly connectIntegrationFromSettings: (
    agentId: string,
    input: {
      readonly actor: Actor;
      readonly callbackUrl: string;
      readonly toolkit: IntegrationToolkit;
    },
  ) => Promise<object | null>;
  readonly disconnectIntegrationFromSettings: (
    agentId: string,
    input: { readonly actor: Actor; readonly toolkit: IntegrationToolkit },
  ) => Promise<object | null>;
  readonly inspectIntegrationConnections: (agentId: string, actor: Actor) => Promise<object | null>;
}

export interface Bindings {
  readonly OSFO_DIRECTORY: {
    readonly getByName: (identity: string) => IntegrationsDirectoryStub;
  };
}

/** Implement authenticated Integration Connection inspection and lifecycle routes. */
export const layer = (bindings: Bindings, callbackUrl: URL) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const directory = yield* AgentDirectory.make;
      const stub = bindings.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
      return HttpApiBuilder.group(Api, "integrations", (handlers) =>
        handlers
          .handle("inspect", () =>
            withRoute(directory, (agentId, actor) =>
              decodeRpc(
                stub.inspectIntegrationConnections(agentId, actor),
                IntegrationConnectionSummary,
              ),
            ),
          )
          .handle("connect", ({ payload }) =>
            withRoute(directory, (agentId, actor) =>
              decodeRpc(
                stub.connectIntegrationFromSettings(agentId, {
                  actor,
                  callbackUrl: callbackUrl.href,
                  toolkit: payload.toolkit,
                }),
                IntegrationConnectRedirect,
              ),
            ),
          )
          .handle("disconnect", ({ payload }) =>
            withRoute(directory, (agentId, actor) =>
              decodeRpc(
                stub.disconnectIntegrationFromSettings(agentId, {
                  actor,
                  toolkit: payload.toolkit,
                }),
                IntegrationConnectionChanged,
              ),
            ),
          ),
      );
    }),
  );

const withRoute = <Value>(
  directory: AgentDirectory.Interface,
  use: (agentId: string, actor: Actor) => Effect.Effect<Value, IntegrationsUnavailable>,
) =>
  Effect.gen(function* () {
    const currentUser = yield* CurrentUser;
    const route = yield* directory.resolve(UserId.make(currentUser.userId));
    return yield* use(route.agentId, {
      authSessionId: currentUser.authSessionId,
      userId: currentUser.userId,
    });
  }).pipe(Effect.mapError(() => unavailable()));

const decodeRpc = <S extends Schema.Top>(promise: Promise<object | null>, schema: S) =>
  Effect.tryPromise({ try: () => promise, catch: unavailable }).pipe(
    Effect.flatMap((value) => Schema.decodeEffect(schema)(value)),
    Effect.mapError(() => unavailable()),
  );

const unavailable = () =>
  new IntegrationsUnavailable({
    message: "Integration connections are temporarily unavailable. Please try again.",
  });

export * as IntegrationHandlers from "./integrations";
