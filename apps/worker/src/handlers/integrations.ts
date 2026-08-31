/* oxlint-disable osfo/no-unknown-parameters, osfo/no-unknown-returns -- This handler owns Cloudflare RPC values and schema-decodes them immediately. */

import {
  Api,
  CurrentUser,
  GmailSendApprovalDecisionAccepted,
  GmailSends,
  GmailSendStatus,
  IntegrationConnectionChanged,
  IntegrationConnectionSummary,
  IntegrationConnectRedirect,
  IntegrationsUnavailable,
  type IntegrationToolkit,
  type CurrentUserValue,
} from "@osfo/api";
import { Effect, Layer, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { UserId } from "../domain";
import { AgentDirectory } from "../services/agent-directory";
import {
  ActionPresentationsFound,
  ApprovalDecisionAccepted,
  type DecideActionApprovalRequest,
} from "../agents/osfo/think-action-approvals";
import { ImmediateGmailApprovals } from "../services/immediate-gmail-approvals";

interface Actor {
  readonly authSessionId: string;
  readonly userId: string;
}

interface IntegrationsDirectoryStub {
  readonly decideActionApproval: (
    agentId: string,
    input: DecideActionApprovalRequest,
  ) => Promise<unknown>;
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
  readonly inspectImmediateGmailSends: (agentId: string, actor: Actor) => Promise<object | null>;
  readonly listActionPresentations: (
    agentId: string,
    actor: unknown,
    selection?: "immediate-gmail",
  ) => Promise<unknown>;
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
          .handle("gmailSends", () =>
            withCurrentUserRoute(directory, (agentId, currentUser) => {
              const approvals = gmailApprovals(stub, agentId, currentUser);
              return Effect.all({
                approvals: approvals.list(),
                statuses: decodeRpc(
                  stub.inspectImmediateGmailSends(agentId, settingsActorFor(currentUser)),
                  Schema.Struct({ items: Schema.Array(GmailSendStatus) }),
                ).pipe(Effect.map(({ items }) => items)),
              }).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(GmailSends)),
                Effect.mapError(() => unavailable()),
              );
            }),
          )
          .handle("decideGmailSend", ({ payload }) =>
            withCurrentUserRoute(directory, (agentId, currentUser) => {
              const approvals = gmailApprovals(stub, agentId, currentUser);
              return approvals.decide(payload).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(GmailSendApprovalDecisionAccepted)),
                Effect.mapError(() => unavailable()),
              );
            }),
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

const withCurrentUserRoute = <Value>(
  directory: AgentDirectory.Interface,
  use: (
    agentId: string,
    currentUser: CurrentUserValue,
  ) => Effect.Effect<Value, IntegrationsUnavailable>,
) =>
  Effect.gen(function* () {
    const currentUser = yield* CurrentUser;
    const route = yield* directory.resolve(UserId.make(currentUser.userId));
    return yield* use(route.agentId, currentUser);
  }).pipe(Effect.mapError(() => unavailable()));

const gmailApprovals = (
  stub: IntegrationsDirectoryStub,
  agentId: string,
  currentUser: CurrentUserValue,
) =>
  ImmediateGmailApprovals.make({
    decide: (decision) => {
      const baseRequest: DecideActionApprovalRequest = {
        actor: approvalActorFor(currentUser),
        decision: decision.decision,
        presentationId: decision.presentationId,
      };
      const request =
        decision.reason === undefined ? baseRequest : { ...baseRequest, reason: decision.reason };
      return decodeRpc(stub.decideActionApproval(agentId, request), ApprovalDecisionAccepted).pipe(
        Effect.mapError(
          () => new ImmediateGmailApprovals.Unavailable({ message: "Decision unavailable" }),
        ),
      );
    },
    list: decodeRpc(
      stub.listActionPresentations(agentId, approvalActorFor(currentUser), "immediate-gmail"),
      ActionPresentationsFound,
    ).pipe(
      Effect.mapError(
        () => new ImmediateGmailApprovals.Unavailable({ message: "Approvals unavailable" }),
      ),
    ),
  });

const settingsActorFor = (currentUser: CurrentUserValue): Actor => ({
  authSessionId: currentUser.authSessionId,
  userId: currentUser.userId,
});

const approvalActorFor = (currentUser: CurrentUserValue) => ({
  _tag: "AuthSession" as const,
  authSessionId: currentUser.authSessionId,
  expiresAt: currentUser.authSessionExpiresAt.toISOString(),
  userId: currentUser.userId,
});

const decodeRpc = <S extends Schema.Top>(promise: Promise<unknown>, schema: S) =>
  Effect.tryPromise({ try: () => promise, catch: unavailable }).pipe(
    Effect.flatMap((value) => Schema.decodeEffect(schema)(value)),
    Effect.mapError(() => unavailable()),
  );

const unavailable = () =>
  new IntegrationsUnavailable({
    message: "Integration connections are temporarily unavailable. Please try again.",
  });

export * as IntegrationHandlers from "./integrations";
