/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect is the entry point for its isolated service Layer. */
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";

import { AgentId, PlanPolicyVersion, UserId } from "../domain";
import { AdminActorId, AdminReason } from "../domain/account-administration";
import { ActionId } from "../domain/action-execution";
import { DeletionCaseId } from "../domain/deletion-case";
import { AccountDeletion } from "./account-deletion";
import { ApprovalPresentation } from "./authorization";
import { MemoryProvider } from "./memory-provider";

it.effect("keeps local data pending until provider deletion confirms permanent absence", () => {
  const calls: Array<string> = [];
  const candidate = {
    _tag: "SelfService" as const,
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
    integrations: { pending: () => Effect.succeed([]), revoke: () => Effect.void },
    objects: {
      remove: (_, authorizeDelete) =>
        authorizeDelete.pipe(Effect.andThen(Effect.sync(() => calls.push("objects")))),
    },
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
      "recheck",
      "objects",
      "recheck",
      "agent",
      "recheck",
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

it.effect("stops before object deletion when authority changes during provider deletion", () =>
  expectStopsWhenAuthorityChangesAfter("provider", [
    "recheck",
    "quiesce",
    "recheck",
    "provider",
    "recheck",
  ]),
);

it.effect("stops before Agent deletion when authority changes during object deletion", () =>
  expectStopsWhenAuthorityChangesAfter("objects", [
    "recheck",
    "quiesce",
    "recheck",
    "provider",
    "recheck",
    "objects",
    "recheck",
  ]),
);

it.effect("stops before PostgreSQL deletion when authority changes during Agent deletion", () =>
  expectStopsWhenAuthorityChangesAfter("agent", [
    "recheck",
    "quiesce",
    "recheck",
    "provider",
    "recheck",
    "objects",
    "recheck",
    "agent",
    "recheck",
  ]),
);

const expectStopsWhenAuthorityChangesAfter = (
  changedAfter: "agent" | "objects" | "provider",
  expectedCalls: ReadonlyArray<string>,
) => {
  const calls: Array<string> = [];
  let authorized = true;
  const candidate = {
    _tag: "SelfService" as const,
    agentId: AgentId.make("agent-1"),
    approvalActionId: ActionId.make("account-delete-1"),
    approvalPresentation: ApprovalPresentation.make("Delete account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  const recordEffect = (operation: "agent" | "objects") =>
    Effect.sync(() => {
      calls.push(operation);
      if (changedAfter === operation) authorized = false;
    });
  const port = AccountDeletion.Port.of({
    inspectAuthorization: () =>
      Effect.sync(() => {
        calls.push("recheck");
        return authorized ? activeFacts(candidate.userId) : null;
      }),
    agents: {
      quiesce: () => Effect.sync(() => calls.push("quiesce")),
      remove: () => recordEffect("agent"),
    },
    integrations: { pending: () => Effect.succeed([]), revoke: () => Effect.void },
    objects: {
      remove: (_, authorizeDelete) => authorizeDelete.pipe(Effect.andThen(recordEffect("objects"))),
    },
    persistence: {
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.die(new Error("Unexpected PostgreSQL deletion")),
    },
  });
  return Effect.gen(function* () {
    const deletion = yield* AccountDeletion.Service;
    const result = yield* deletion.reconcileOne(candidate).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(calls).toEqual(expectedCalls);
  }).pipe(
    Effect.provide(
      accountDeletionLayer(port, calls, () => {
        if (changedAfter === "provider") authorized = false;
        return "deleted";
      }),
    ),
  );
};

it.effect("does not delete provider knowledge when authority changes during quiescence", () => {
  const calls: Array<string> = [];
  let checks = 0;
  const candidate = {
    _tag: "SelfService" as const,
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
    integrations: { pending: () => Effect.succeed([]), revoke: () => Effect.void },
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

it.effect("does not advance when Agent quiescence fails", () => {
  const calls: Array<string> = [];
  const candidate = {
    _tag: "SelfService" as const,
    agentId: AgentId.make("agent-1"),
    approvalActionId: ActionId.make("account-delete-1"),
    approvalPresentation: ApprovalPresentation.make("Delete account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  const port = AccountDeletion.Port.of({
    inspectAuthorization: () => Effect.succeed(activeFacts(candidate.userId)),
    agents: {
      quiesce: () =>
        Effect.sync(() => calls.push("quiesce")).pipe(
          Effect.andThen(
            Effect.fail(
              new AccountDeletion.AccountDeletionUnavailable({
                cause: { _tag: "ThinkSubmissionUnavailable" },
                message: "Agent provider activity could not be quiesced",
                operation: "quiesceAgentAccountDeletion",
              }),
            ),
          ),
        ),
      remove: () => Effect.sync(() => calls.push("agent")),
    },
    integrations: { pending: () => Effect.succeed([]), revoke: () => Effect.void },
    objects: { remove: () => Effect.sync(() => calls.push("objects")) },
    persistence: {
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.sync(() => calls.push("postgres")),
    },
  });

  return Effect.gen(function* () {
    const deletion = yield* AccountDeletion.Service;
    const result = yield* deletion.reconcileOne(candidate).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(calls).toEqual(["quiesce"]);
  }).pipe(Effect.provide(accountDeletionLayer(port, calls, () => "deleted")));
});

it.effect(
  "retains per-connection progress and preserves another User's integration authority",
  () => {
    const calls: Array<string> = [];
    const candidate = {
      _tag: "SelfService" as const,
      agentId: AgentId.make("agent-1"),
      approvalActionId: ActionId.make("account-delete-1"),
      approvalPresentation: ApprovalPresentation.make("Delete account"),
      deletionCaseId: DeletionCaseId.make("deletion-case-1"),
      userId: UserId.make("user-1"),
    };
    const unrelatedUserId = UserId.make("user-2");
    const targets = [
      {
        connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("connection-1"),
        userId: candidate.userId,
      },
      {
        connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("connection-2"),
        userId: candidate.userId,
      },
      {
        connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("unrelated-connection"),
        userId: unrelatedUserId,
      },
    ];
    let secondTargetAttempts = 0;
    const port = AccountDeletion.Port.of({
      inspectAuthorization: () =>
        Effect.sync(() => calls.push("recheck")).pipe(Effect.as(activeFacts(candidate.userId))),
      agents: {
        quiesce: () => Effect.sync(() => calls.push("quiesce")),
        remove: () => Effect.sync(() => calls.push("agent")),
      },
      integrations: {
        pending: (userId) =>
          Effect.sync(() => {
            calls.push("connections");
            return targets.filter((target) => target.userId === userId);
          }),
        revoke: (target) =>
          Effect.suspend(() => {
            calls.push(target.connectionId);
            if (target.connectionId === "connection-2" && secondTargetAttempts === 0) {
              secondTargetAttempts += 1;
              return Effect.fail(
                new AccountDeletion.AccountDeletionUnavailable({
                  cause: target,
                  message: "Provider revocation remains pending",
                  operation: "deleteIntegrationAuthority",
                }),
              );
            }
            targets.splice(targets.indexOf(target), 1);
            return Effect.void;
          }),
      },
      objects: {
        remove: (_, authorizeDelete) =>
          authorizeDelete.pipe(Effect.andThen(Effect.sync(() => calls.push("objects")))),
      },
      persistence: {
        pending: Effect.succeed([candidate]),
        removeUser: () => Effect.sync(() => calls.push("postgres")),
      },
    });

    return Effect.gen(function* () {
      const deletion = yield* AccountDeletion.Service;
      const first = yield* deletion.reconcileOne(candidate).pipe(Effect.result);
      expect(Result.isFailure(first)).toBe(true);
      expect(targets.map(({ connectionId }) => connectionId)).toEqual([
        "connection-2",
        "unrelated-connection",
      ]);

      yield* deletion.reconcileOne(candidate);
      expect(targets).toEqual([
        {
          connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("unrelated-connection"),
          userId: unrelatedUserId,
        },
      ]);
      expect(calls.filter((call) => call === "connection-1")).toHaveLength(1);
      expect(calls.filter((call) => call === "connection-2")).toHaveLength(2);
      expect(
        calls.every(
          (call, index) => !call.startsWith("connection-") || calls[index - 1] === "recheck",
        ),
      ).toBe(true);
      expect(calls).toContain("postgres");
    }).pipe(Effect.provide(accountDeletionLayer(port, calls, () => "deleted")));
  },
);

it.effect("rechecks a retained administrative case through every protected stage", () => {
  const calls: Array<string> = [];
  const userId = UserId.make("user-1");
  const candidate = {
    _tag: "Administrative" as const,
    adminActorId: AdminActorId.make("admin-1"),
    agentId: AgentId.make("agent-1"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    reason: AdminReason.make("Required administrative erasure"),
    userId,
  };
  const port = AccountDeletion.Port.of({
    inspectAuthorization: () =>
      Effect.sync(() => calls.push("recheck")).pipe(
        Effect.as({
          ...activeFacts(userId),
          user: { _tag: "SuspendedUser" as const, userId },
        }),
      ),
    agents: {
      quiesce: () => Effect.sync(() => calls.push("quiesce")),
      remove: () => Effect.sync(() => calls.push("agent")),
    },
    integrations: { pending: () => Effect.succeed([]), revoke: () => Effect.void },
    objects: {
      remove: (_, authorizeDelete) =>
        authorizeDelete.pipe(Effect.andThen(Effect.sync(() => calls.push("objects")))),
    },
    persistence: {
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.sync(() => calls.push("postgres")),
    },
  });

  return Effect.gen(function* () {
    const deletion = yield* AccountDeletion.Service;
    yield* deletion.reconcileOne(candidate);
    expect(calls).toEqual([
      "recheck",
      "quiesce",
      "recheck",
      "provider",
      "recheck",
      "objects",
      "recheck",
      "agent",
      "recheck",
      "postgres",
    ]);
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
      findSessionConversation: () => Effect.die(new Error("unexpected Session discovery")),
      forgetKnowledge: () => Effect.die(new Error("unexpected forgetting")),
      getConversationStatus: () => Effect.die(new Error("unexpected status read")),
      recall: () => Effect.die(new Error("unexpected recall")),
      saveConversation: () => Effect.die(new Error("unexpected conversation save")),
      verifySessionConversation: () => Effect.die(new Error("unexpected Session verification")),
    }),
  );
