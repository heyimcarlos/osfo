/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect is the entry point for its isolated service Layer. */
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";

import { AgentId, PlanPolicyVersion, UserId } from "../domain";
import { ActionId } from "../domain/action-execution";
import { DeletionCaseId } from "../domain/deletion-case";
import { AccountDeletion } from "./account-deletion";
import { ApprovalPresentation } from "./authorization";
import { MemoryProvider } from "./memory-provider";

it.effect("keeps local data pending until provider deletion confirms permanent absence", () => {
  const calls: Array<string> = [];
  const candidate = {
    agentId: AgentId.make("agent-1"),
    approvalActionId: ActionId.make("account-delete-1"),
    approvalPresentation: ApprovalPresentation.make("Delete account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  let providerAttempts = 0;
  const port = AccountDeletion.Port.of({
    inspectAuthorization: () =>
      Effect.sync(() => calls.push("recheck")).pipe(Effect.as(activeFacts(candidate.userId))),
    agents: {
      quiesce: () => Effect.sync(() => calls.push("quiesce")),
      remove: () => Effect.sync(() => calls.push("agent")),
    },
    objects: { remove: () => Effect.sync(() => calls.push("objects")) },
    persistence: {
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.sync(() => calls.push("postgres")),
    },
  });
  return Effect.gen(function* () {
    const deletion = yield* AccountDeletion.Service;
    const unavailable = yield* deletion.reconcileOne(candidate).pipe(Effect.result);
    expect(Result.isFailure(unavailable)).toBe(true);
    expect(calls).toEqual(["recheck", "quiesce", "recheck", "provider"]);

    yield* deletion.reconcileOne(candidate);
    expect(calls).toEqual([
      "recheck",
      "quiesce",
      "recheck",
      "provider",
      "recheck",
      "quiesce",
      "recheck",
      "provider",
      "objects",
      "agent",
      "postgres",
    ]);
  }).pipe(
    Effect.provide(
      accountDeletionLayer(port, calls, () => {
        providerAttempts += 1;
        return providerAttempts === 1 ? "unavailable" : "deleted";
      }),
    ),
  );
});

it.effect("does not delete provider knowledge when authority changes during quiescence", () => {
  const calls: Array<string> = [];
  let checks = 0;
  const candidate = {
    agentId: AgentId.make("agent-1"),
    approvalActionId: ActionId.make("account-delete-1"),
    approvalPresentation: ApprovalPresentation.make("Delete account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  const port = AccountDeletion.Port.of({
    inspectAuthorization: () =>
      Effect.sync(() => {
        calls.push("recheck");
        checks += 1;
        const facts = activeFacts(candidate.userId);
        return checks === 1
          ? facts
          : { ...facts, user: { _tag: "SuspendedUser", userId: candidate.userId } as const };
      }),
    agents: {
      quiesce: () => Effect.sync(() => calls.push("quiesce")),
      remove: () => Effect.die(new Error("Unexpected Agent deletion")),
    },
    objects: { remove: () => Effect.die(new Error("Unexpected object deletion")) },
    persistence: {
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.die(new Error("Unexpected PostgreSQL deletion")),
    },
  });

  return Effect.gen(function* () {
    const deletion = yield* AccountDeletion.Service;
    yield* deletion.reconcileOne(candidate).pipe(Effect.result);
    expect(calls).toEqual(["recheck", "quiesce", "recheck"]);
  }).pipe(Effect.provide(accountDeletionLayer(port, calls, () => "deleted")));
});

const accountDeletionLayer = (
  port: AccountDeletion.PortInterface,
  calls: Array<string>,
  result: () => "deleted" | "unavailable",
) =>
  AccountDeletion.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.merge(Layer.succeed(AccountDeletion.Port, port), providerLayer(result, calls)),
    ),
  );

const activeFacts = (userId: UserId): AccountDeletion.CurrentAuthorizationFacts => ({
  resourceOwnerUserId: userId,
  subscription: { plan: "free", planPolicyVersion: PlanPolicyVersion.make("launch-v1") },
  user: { _tag: "ActiveUser", userId },
});

const providerLayer = (result: () => "deleted" | "unavailable", calls: Array<string>) =>
  Layer.succeed(
    MemoryProvider.Service,
    MemoryProvider.Service.of({
      checkConversationSearchability: () =>
        Effect.die(new Error("unexpected conversation searchability check")),
      configureOrganizationGuidance: Effect.die(
        new Error("unexpected organization guidance configuration"),
      ),
      configureUserGuidance: () => Effect.die(new Error("unexpected User guidance configuration")),
      deleteSessionConversation: () => Effect.die(new Error("unexpected Session deletion")),
      deleteUserKnowledge: () => {
        calls.push("provider");
        return result() === "deleted"
          ? Effect.succeed({ _tag: "Deleted" as const })
          : Effect.fail(
              new MemoryProvider.MemoryProviderUnavailable({
                message: "try again",
                operation: "deleteUserKnowledge",
              }),
            );
      },
      forgetKnowledge: () => Effect.die(new Error("unexpected forgetting")),
      getConversationStatus: () => Effect.die(new Error("unexpected status read")),
      recall: () => Effect.die(new Error("unexpected recall")),
      saveConversation: () => Effect.die(new Error("unexpected conversation save")),
    }),
  );
