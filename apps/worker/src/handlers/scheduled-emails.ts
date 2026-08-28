/* oxlint-disable osfo/no-unknown-parameters, osfo/no-unknown-returns -- This handler owns and immediately decodes the Directory RPC trust boundary. */
import {
  Api,
  CurrentUser,
  ScheduledEmailsUnavailable,
  type CurrentUserValue,
} from "@osfo/api";
import { Effect, Layer, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import {
  ActionPresentationsFound,
  ApprovalDecisionAccepted,
  type DecideActionApprovalRequest,
} from "../agents/osfo/think-action-approvals";
import { UserId } from "../domain";
import { AgentDirectory } from "../services/agent-directory";
import { ScheduledEmailFollowUp } from "../services/scheduled-email-follow-up";

interface DirectoryStub {
  readonly decideActionApproval: (
    agentId: string,
    input: DecideActionApprovalRequest,
  ) => Promise<unknown>;
  readonly listActionPresentations: (agentId: string, actor: unknown) => Promise<unknown>;
}

export interface Bindings {
  readonly OSFO_DIRECTORY: { readonly getByName: (name: string) => DirectoryStub };
}

/** Expose exact pending Approval decisions and delivered safe status for Scheduled Email. */
export const layer = (bindings: Bindings) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const directory = yield* AgentDirectory.make;
      const followUps = yield* ScheduledEmailFollowUp.Service;
      const stub = bindings.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
      return HttpApiBuilder.group(Api, "scheduledEmails", (handlers) =>
        handlers
          .handle("approvals", () =>
            withAgent(directory, (agentId, currentUser) =>
              listApprovals(stub, agentId, currentUser),
            ),
          )
          .handle("decideApproval", ({ payload }) =>
            withAgent(directory, (agentId, currentUser) =>
              decideApproval(stub, agentId, currentUser, payload),
            ),
          )
          .handle("notifications", () =>
            CurrentUser.pipe(
              Effect.flatMap((currentUser) =>
                followUps.deliveredForUser(UserId.make(currentUser.userId)),
              ),
              Effect.map((items) => ({
                items: items.map((item) => ({
                  deliveredAt: item.acceptedAt ?? item.claimedAt,
                  state: item.state,
                  workflowId: item.workflowId,
                })),
              })),
              Effect.mapError(() => unavailable()),
            ),
          ),
      );
    }),
  );

const withAgent = <Value>(
  directory: AgentDirectory.Interface,
  use: (agentId: string, currentUser: CurrentUserValue) => Effect.Effect<Value, ScheduledEmailsUnavailable>,
) =>
  Effect.gen(function* () {
    const currentUser = yield* CurrentUser;
    const route = yield* directory.resolve(UserId.make(currentUser.userId));
    return yield* use(route.agentId, currentUser);
  }).pipe(Effect.mapError(() => unavailable()));

const listApprovals = (
  stub: DirectoryStub,
  agentId: string,
  currentUser: CurrentUserValue,
) =>
  rpc(
    stub.listActionPresentations(agentId, actorFor(currentUser)),
    ActionPresentationsFound,
  ).pipe(
    Effect.map(({ presentations }) => ({
      items: presentations
        .filter(
          ({ actionDefinitionVersion, operation }) =>
            operation === "integration.effect" &&
            actionDefinitionVersion === "osfo-scheduled-email-start-v1",
        )
        .map(({ actionId, consequences, description, fields, presentationId, title }) => ({
          actionId,
          consequences,
          description,
          fields,
          presentationId,
          title,
        })),
    })),
  );

const decideApproval = (
  stub: DirectoryStub,
  agentId: string,
  currentUser: CurrentUserValue,
  payload: { readonly decision: "approve" | "reject"; readonly presentationId: string; readonly reason?: string | undefined },
) => {
  const baseRequest: DecideActionApprovalRequest = {
    actor: actorFor(currentUser),
    decision: payload.decision,
    presentationId: payload.presentationId,
  };
  const request: DecideActionApprovalRequest =
    payload.reason === undefined ? baseRequest : { ...baseRequest, reason: payload.reason };
  return listApprovals(stub, agentId, currentUser).pipe(
    Effect.filterOrFail(
      ({ items }) => items.some(({ presentationId }) => presentationId === payload.presentationId),
      unavailable,
    ),
    Effect.andThen(
      rpc(
        stub.decideActionApproval(agentId, request),
        ApprovalDecisionAccepted,
      ),
    ),
    Effect.map(({ decision, presentationId }) => ({
      decision: decision === "canceled" ? "rejected" as const : decision,
      presentationId,
    })),
  );
};

const actorFor = (currentUser: CurrentUserValue) => ({
  _tag: "AuthSession" as const,
  authSessionId: currentUser.authSessionId,
  expiresAt: currentUser.authSessionExpiresAt.toISOString(),
  userId: currentUser.userId,
});

const rpc = <S extends Schema.Top>(promise: Promise<unknown>, schema: S) =>
  Effect.tryPromise({ try: () => promise, catch: unavailable }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(() => unavailable()),
  );

const unavailable = () =>
  new ScheduledEmailsUnavailable({
    message: "Scheduled Email controls are temporarily unavailable. Please try again.",
  });

export * as ScheduledEmailHandlers from "./scheduled-emails";
