/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect is the entry point for its isolated service Layer. */
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Result } from "effect";

import { AgentId, PlanPolicyVersion, UserId } from "../domain";
import { AdminActorId, AdminReason } from "../domain/account-administration";
import { ActionId } from "../domain/action-execution";
import { DeletionCaseId } from "../domain/deletion-case";
import { qualificationCohortScrubDispatchIdentity } from "../qualification/cohort-scrub-dispatch";
import { AccountDeletion } from "./account-deletion";
import { ApprovalPresentation } from "./authorization";
import { MemoryProvider } from "./memory-provider";
import { makeAccountDeletionFence } from "../agents/osfo/account-deletion-fence";

const testPort = (
  port: Omit<AccountDeletion.PortInterface, "qualificationScrub" | "workflows"> &
    Partial<Pick<AccountDeletion.PortInterface, "qualificationScrub" | "workflows">>,
) =>
  AccountDeletion.Port.of({
    qualificationScrub: { dispatch: () => Effect.void },
    workflows: { quiesce: () => Effect.void },
    ...port,
  });

it.effect("acknowledges an exact fenced case only after admitted Agent work drains", () => {
  const candidate = {
    _tag: "SelfService" as const,
    agentId: AgentId.make("agent-1"),
    approvalActionId: ActionId.make("account-delete-1"),
    approvalPresentation: ApprovalPresentation.make("Delete Account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  const calls = new Array<string>();
  const fence = makeAccountDeletionFence();
  const port = testPort({
    inspectAuthorization: () =>
      Effect.sync(() => calls.push("recheck")).pipe(Effect.as(activeFacts(candidate.userId))),
    agents: {
      quiesce: () => Effect.sync(() => calls.push("quiesce")).pipe(Effect.andThen(fence.close)),
      remove: () => Effect.die(new Error("Unexpected Agent removal")),
    },
    workflows: {
      quiesce: () => Effect.sync(() => calls.push("workflows")),
    },
    integrations: {
      pending: () => Effect.die(new Error("Unexpected discovery")),
      revoke: () => Effect.void,
    },
    objects: { remove: () => Effect.die(new Error("Unexpected R2 deletion")) },
    persistence: {
      ...passthroughIntegrationProgress,
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.die(new Error("Unexpected PostgreSQL deletion")),
    },
  });

  return Effect.gen(function* () {
    const providerStarted = yield* Deferred.make<void>();
    const releaseProvider = yield* Deferred.make<void>();
    const mutations = new Array<string>();
    const providerContinuation = yield* fence
      .runTracked(
        (signal) =>
          Deferred.succeed(providerStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseProvider)),
            Effect.andThen(
              Effect.sync(() => {
                if (!signal.aborted) mutations.push("provider", "sqlite", "outbox");
              }),
            ),
          ),
        () => "account deletion fenced" as const,
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(providerStarted);
    const deletion = yield* AccountDeletion.Service;
    const acknowledgment = yield* deletion
      .quiesceCase(candidate.userId, candidate.deletionCaseId)
      .pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    expect(acknowledgment.pollUnsafe()).toBeUndefined();
    expect(calls).toEqual(["recheck", "quiesce"]);
    yield* Deferred.succeed(releaseProvider, undefined);
    yield* Fiber.join(providerContinuation);
    yield* Fiber.join(acknowledgment);
    expect(calls).toEqual(["recheck", "quiesce", "workflows"]);
    expect(mutations).toEqual([]);

    const lateMutation = yield* fence
      .runTracked(
        () => Effect.sync(() => mutations.push("late")),
        () => "account deletion fenced" as const,
      )
      .pipe(Effect.flip);
    expect(lateMutation).toBe("account deletion fenced");
    expect(mutations).toEqual([]);
  }).pipe(Effect.provide(accountDeletionLayer(port, calls, () => "deleted")));
});

it.effect(
  "scheduled reconciliation retries a retained case after synchronous quiescence fails",
  () => {
    const calls = new Array<string>();
    const candidate = {
      _tag: "SelfService" as const,
      agentId: AgentId.make("agent-1"),
      approvalActionId: ActionId.make("account-delete-1"),
      approvalPresentation: ApprovalPresentation.make("Delete Account"),
      deletionCaseId: DeletionCaseId.make("deletion-case-1"),
      userId: UserId.make("user-1"),
    };
    let quiescenceAttempts = 0;
    const port = testPort({
      inspectAuthorization: () =>
        Effect.sync(() => calls.push("recheck")).pipe(Effect.as(activeFacts(candidate.userId))),
      agents: {
        quiesce: () =>
          Effect.suspend(() => {
            calls.push("quiesce");
            quiescenceAttempts += 1;
            return quiescenceAttempts === 1
              ? Effect.fail(
                  new AccountDeletion.AccountDeletionUnavailable({
                    cause: "Agent unavailable",
                    message: "Agent quiescence remains pending",
                    operation: "quiesceAgentAccountDeletion",
                  }),
                )
              : Effect.void;
          }),
        remove: () => Effect.sync(() => calls.push("agent")),
      },
      integrations: { pending: () => Effect.succeed([]), revoke: () => Effect.void },
      objects: {
        remove: (_, authorizeDelete) =>
          authorizeDelete.pipe(Effect.andThen(Effect.sync(() => calls.push("objects")))),
      },
      persistence: {
        ...passthroughIntegrationProgress,
        pending: Effect.succeed([candidate]),
        removeUser: () => Effect.sync(() => calls.push("postgres")).pipe(Effect.as(undefined)),
      },
    });

    return Effect.gen(function* () {
      const deletion = yield* AccountDeletion.Service;
      expect(
        Result.isFailure(
          yield* deletion
            .quiesceCase(candidate.userId, candidate.deletionCaseId)
            .pipe(Effect.result),
        ),
      ).toBe(true);
      expect(calls).toEqual(["recheck", "quiesce"]);

      yield* deletion.reconcilePending();
      expect(calls).toEqual([
        "recheck",
        "quiesce",
        "recheck",
        "quiesce",
        "recheck",
        "provider",
        "recheck",
        "recheck",
        "recheck",
        "recheck",
        "objects",
        "recheck",
        "agent",
        "recheck",
        "postgres",
      ]);
    }).pipe(Effect.provide(accountDeletionLayer(port, calls, () => "deleted")));
  },
);

it.effect("acknowledges an exact fenced case with no Agent as terminally quiesced", () => {
  const calls = new Array<string>();
  const candidate = {
    _tag: "SelfService" as const,
    agentId: null,
    approvalActionId: ActionId.make("account-delete-1"),
    approvalPresentation: ApprovalPresentation.make("Delete Account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  const port = testPort({
    inspectAuthorization: () =>
      Effect.sync(() => calls.push("recheck")).pipe(Effect.as(activeFacts(candidate.userId))),
    agents: {
      quiesce: () => Effect.die(new Error("Absent Agent must not be called")),
      remove: () => Effect.die(new Error("Absent Agent must not be removed")),
    },
    integrations: {
      pending: () => Effect.die(new Error("Unexpected discovery")),
      revoke: () => Effect.void,
    },
    objects: { remove: () => Effect.die(new Error("Unexpected R2 deletion")) },
    persistence: {
      ...passthroughIntegrationProgress,
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.die(new Error("Unexpected PostgreSQL deletion")),
    },
  });
  return AccountDeletion.Service.pipe(
    Effect.flatMap((deletion) => deletion.quiesceCase(candidate.userId, candidate.deletionCaseId)),
    Effect.andThen(Effect.sync(() => expect(calls).toEqual(["recheck"]))),
    Effect.provide(accountDeletionLayer(port, calls, () => "deleted")),
  );
});

it.effect("orders the Agent fence before Workflow hosts and private-data erasure", () => {
  const candidate = {
    _tag: "SelfService" as const,
    agentId: AgentId.make("agent-1"),
    approvalActionId: ActionId.make("account-delete-1"),
    approvalPresentation: ApprovalPresentation.make("Delete Account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  const calls = new Array<string>();
  const port = testPort({
    inspectAuthorization: () => Effect.succeed(activeFacts(candidate.userId)),
    agents: {
      quiesce: () => Effect.sync(() => calls.push("directory-fence", "wakeup-cleanup")),
      remove: () => Effect.sync(() => calls.push("agent-erase")),
    },
    integrations: { pending: () => Effect.succeed([]), revoke: () => Effect.void },
    workflows: {
      quiesce: () =>
        Effect.sync(() => calls.push("workflow-terminal", "main-terminate", "timer-terminate")),
    },
    objects: {
      remove: (_, authorizeDelete) =>
        authorizeDelete.pipe(Effect.andThen(Effect.sync(() => calls.push("r2-erase")))),
    },
    persistence: {
      ...passthroughIntegrationProgress,
      ensureAccessFence: () => Effect.sync(() => calls.push("access-fence")),
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.sync(() => calls.push("postgres-erase")).pipe(Effect.as(undefined)),
    },
  });

  return AccountDeletion.Service.pipe(
    Effect.flatMap((deletion) => deletion.reconcileOne(candidate)),
    Effect.andThen(
      Effect.sync(() =>
        expect(calls).toEqual([
          "access-fence",
          "directory-fence",
          "wakeup-cleanup",
          "workflow-terminal",
          "main-terminate",
          "timer-terminate",
          "provider",
          "r2-erase",
          "agent-erase",
          "postgres-erase",
        ]),
      ),
    ),
    Effect.provide(accountDeletionLayer(port, calls, () => "deleted")),
  );
});

it.effect("rejects quiescence for a nonexact retained Deletion Case", () => {
  const candidate = {
    _tag: "SelfService" as const,
    agentId: AgentId.make("agent-1"),
    approvalActionId: ActionId.make("account-delete-1"),
    approvalPresentation: ApprovalPresentation.make("Delete Account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  const calls = new Array<string>();
  const port = testPort({
    inspectAuthorization: () => Effect.die(new Error("Nonexact case must not be authorized")),
    agents: {
      quiesce: () => Effect.die(new Error("Nonexact case must not reach the Agent")),
      remove: () => Effect.die(new Error("Unexpected Agent removal")),
    },
    integrations: {
      pending: () => Effect.die(new Error("Unexpected discovery")),
      revoke: () => Effect.void,
    },
    objects: { remove: () => Effect.die(new Error("Unexpected R2 deletion")) },
    persistence: {
      ...passthroughIntegrationProgress,
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.die(new Error("Unexpected PostgreSQL deletion")),
    },
  });

  return Effect.gen(function* () {
    const deletion = yield* AccountDeletion.Service;
    const failure = yield* deletion
      .quiesceCase(candidate.userId, DeletionCaseId.make("deletion-case-other"))
      .pipe(Effect.flip);
    expect(failure.operation).toBe("quiesceAgentAccountDeletion");
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(accountDeletionLayer(port, calls, () => "deleted")));
});

it.effect("keeps local data pending until provider deletion confirms permanent absence", () => {
  const calls: Array<string> = [];
  const candidate = {
    _tag: "SelfService" as const,
    agentId: AgentId.make("agent-1"),
    approvalActionId: ActionId.make("account-delete-1"),
    approvalPresentation: ApprovalPresentation.make("Delete Account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  let providerAttempts = 0;
  const port = testPort({
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
      ...passthroughIntegrationProgress,
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.sync(() => calls.push("postgres")).pipe(Effect.as(undefined)),
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
      "recheck",
      "recheck",
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

it.effect(
  "retries an accepted provider delete until a later read proves the User container absent",
  () => {
    const calls: Array<string> = [];
    const candidate = {
      _tag: "SelfService" as const,
      agentId: AgentId.make("agent-1"),
      approvalActionId: ActionId.make("account-delete-1"),
      approvalPresentation: ApprovalPresentation.make("Delete Account"),
      deletionCaseId: DeletionCaseId.make("deletion-case-1"),
      userId: UserId.make("user-1"),
    };
    let verificationAttempts = 0;
    const port = testPort({
      inspectAuthorization: () =>
        Effect.sync(() => calls.push("recheck")).pipe(Effect.as(activeFacts(candidate.userId))),
      agents: {
        quiesce: () => Effect.sync(() => calls.push("quiesce")),
        remove: () => Effect.sync(() => calls.push("agent")),
      },
      integrations: {
        pending: () => Effect.succeed([]),
        revoke: () => Effect.die(new Error("Unexpected integration target")),
      },
      objects: {
        remove: (_, authorizeDelete) =>
          authorizeDelete.pipe(Effect.andThen(Effect.sync(() => calls.push("objects")))),
      },
      persistence: {
        ...passthroughIntegrationProgress,
        pending: Effect.succeed([candidate]),
        removeUser: () => Effect.sync(() => calls.push("postgres")).pipe(Effect.as(undefined)),
      },
    });
    const provider = MemoryProvider.Service.of({
      ...unexpectedMemoryProvider,
      deleteUserKnowledge: () =>
        Effect.sync(() => calls.push("provider-delete")).pipe(
          Effect.as({ _tag: "Deleted" as const }),
        ),
      verifyUserKnowledge: () =>
        Effect.sync(() => {
          calls.push("provider-verify");
          verificationAttempts += 1;
          return verificationAttempts === 1
            ? ({ _tag: "Verified" } as const)
            : ({ _tag: "AlreadyAbsent" } as const);
        }),
    });

    return Effect.gen(function* () {
      const deletion = yield* AccountDeletion.Service;
      const result = yield* deletion.reconcileOne(candidate).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toEqual([
        "recheck",
        "quiesce",
        "recheck",
        "provider-delete",
        "recheck",
        "provider-verify",
      ]);
      yield* deletion.reconcileOne(candidate);
      expect(calls.slice(-14)).toEqual([
        "recheck",
        "quiesce",
        "recheck",
        "provider-delete",
        "recheck",
        "provider-verify",
        "recheck",
        "recheck",
        "recheck",
        "objects",
        "recheck",
        "agent",
        "recheck",
        "postgres",
      ]);
    }).pipe(
      Effect.provide(
        AccountDeletion.layerWithoutDependencies.pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(AccountDeletion.Port, port),
              Layer.succeed(MemoryProvider.Service, provider),
            ),
          ),
        ),
      ),
    );
  },
);

it.effect(
  "does not begin destructive reconciliation until the exact access fence is durable",
  () => {
    const calls: Array<string> = [];
    const candidate = {
      _tag: "Administrative" as const,
      adminActorId: AdminActorId.make("admin-1"),
      agentId: AgentId.make("agent-1"),
      deletionCaseId: DeletionCaseId.make("deletion-case-1"),
      reason: AdminReason.make("Required erasure"),
      userId: UserId.make("user-1"),
    };
    let fenceAttempts = 0;
    const port = testPort({
      inspectAuthorization: () =>
        Effect.sync(() => calls.push("recheck")).pipe(
          Effect.as({
            ...activeFacts(candidate.userId),
            administrativeAuthority: { adminActorId: candidate.adminActorId },
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
        ...passthroughIntegrationProgress,
        ensureAccessFence: () =>
          Effect.suspend(() => {
            calls.push("fence");
            fenceAttempts += 1;
            return fenceAttempts === 1
              ? Effect.fail(
                  new AccountDeletion.AccountDeletionUnavailable({
                    cause: "session revocation unavailable",
                    message: "Access fence remains pending",
                    operation: "ensureAccessFence",
                  }),
                )
              : Effect.void;
          }),
        pending: Effect.succeed([candidate]),
        removeUser: () => Effect.sync(() => calls.push("postgres")).pipe(Effect.as(undefined)),
      },
    });
    return Effect.gen(function* () {
      const deletion = yield* AccountDeletion.Service;
      yield* deletion.reconcilePending();
      expect(calls).toEqual(["fence"]);

      yield* deletion.reconcilePending();
      expect(calls).toEqual([
        "fence",
        "fence",
        "recheck",
        "quiesce",
        "recheck",
        "provider",
        "recheck",
        "recheck",
        "recheck",
        "recheck",
        "objects",
        "recheck",
        "agent",
        "recheck",
        "postgres",
      ]);
    }).pipe(Effect.provide(accountDeletionLayer(port, calls, () => "deleted")));
  },
);

it.effect("stops before object deletion when authority changes during provider deletion", () =>
  expectStopsWhenAuthorityChangesAfter("provider", [
    "recheck",
    "quiesce",
    "recheck",
    "provider",
    "recheck",
  ]),
);

it.effect("rechecks authority immediately before integration discovery", () => {
  const calls: Array<string> = [];
  let authorized = true;
  const candidate = {
    _tag: "SelfService" as const,
    agentId: AgentId.make("agent-1"),
    approvalActionId: ActionId.make("account-delete-1"),
    approvalPresentation: ApprovalPresentation.make("Delete Account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  const port = testPort({
    inspectAuthorization: () =>
      Effect.sync(() => {
        calls.push("recheck");
        return authorized ? activeFacts(candidate.userId) : null;
      }),
    agents: {
      quiesce: () => Effect.sync(() => calls.push("quiesce")),
      remove: () => Effect.die(new Error("Unexpected Agent deletion")),
    },
    integrations: {
      pending: () => Effect.die(new Error("Unauthorized integration discovery")),
      revoke: () => Effect.die(new Error("Unexpected integration deletion")),
    },
    objects: { remove: () => Effect.die(new Error("Unexpected R2 deletion")) },
    persistence: {
      ...passthroughIntegrationProgress,
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.die(new Error("Unexpected PostgreSQL deletion")),
    },
  });

  return Effect.gen(function* () {
    const deletion = yield* AccountDeletion.Service;
    const result = yield* deletion.reconcileOne(candidate).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(calls).toEqual(["recheck", "quiesce", "recheck", "provider", "recheck"]);
  }).pipe(
    Effect.provide(
      accountDeletionLayer(port, calls, () => {
        authorized = false;
        return "deleted";
      }),
    ),
  );
});

it.effect("does not stage integration progress after authority drifts during discovery", () => {
  const calls: Array<string> = [];
  let authorized = true;
  const candidate = {
    _tag: "SelfService" as const,
    agentId: AgentId.make("agent-1"),
    approvalActionId: ActionId.make("account-delete-1"),
    approvalPresentation: ApprovalPresentation.make("Delete Account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  const target = {
    connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("connection-1"),
    userId: candidate.userId,
  };
  const port = testPort({
    inspectAuthorization: () => Effect.succeed(authorized ? activeFacts(candidate.userId) : null),
    agents: { quiesce: () => Effect.void, remove: () => Effect.die(new Error("unexpected")) },
    integrations: {
      pending: () =>
        Effect.sync(() => {
          authorized = false;
          return [target];
        }),
      revoke: () => Effect.die(new Error("unexpected")),
    },
    objects: { remove: () => Effect.die(new Error("unexpected")) },
    persistence: {
      ...passthroughIntegrationProgress,
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.die(new Error("unexpected")),
      stageIntegrationTargets: () =>
        Effect.sync(() => calls.push("stage")).pipe(Effect.as([target])),
    },
  });
  return AccountDeletion.Service.pipe(
    Effect.flatMap((deletion) => deletion.reconcileOne(candidate)),
    Effect.result,
    Effect.tap(() => Effect.sync(() => expect(calls).toEqual(["provider"]))),
    Effect.provide(accountDeletionLayer(port, calls, () => "deleted")),
  );
});

it.effect("does not confirm integration progress after authority drifts during revocation", () => {
  const calls: Array<string> = [];
  let authorized = true;
  const candidate = {
    _tag: "SelfService" as const,
    agentId: AgentId.make("agent-1"),
    approvalActionId: ActionId.make("account-delete-1"),
    approvalPresentation: ApprovalPresentation.make("Delete Account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  const target = {
    connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("connection-1"),
    userId: candidate.userId,
  };
  const port = testPort({
    inspectAuthorization: () => Effect.succeed(authorized ? activeFacts(candidate.userId) : null),
    agents: { quiesce: () => Effect.void, remove: () => Effect.die(new Error("unexpected")) },
    integrations: {
      pending: () => Effect.succeed([target]),
      revoke: () =>
        Effect.sync(() => {
          calls.push("revoke");
          authorized = false;
        }),
    },
    objects: { remove: () => Effect.die(new Error("unexpected")) },
    persistence: {
      ...passthroughIntegrationProgress,
      confirmIntegrationTarget: () => Effect.sync(() => calls.push("confirm")),
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.die(new Error("unexpected")),
      stageIntegrationTargets: () => Effect.succeed([target]),
    },
  });
  return AccountDeletion.Service.pipe(
    Effect.flatMap((deletion) => deletion.reconcileOne(candidate)),
    Effect.result,
    Effect.tap(() => Effect.sync(() => expect(calls).toEqual(["provider", "revoke"]))),
    Effect.provide(accountDeletionLayer(port, calls, () => "deleted")),
  );
});

it.effect("stops before Agent deletion when authority changes during object deletion", () =>
  expectStopsWhenAuthorityChangesAfter("objects", [
    "recheck",
    "quiesce",
    "recheck",
    "provider",
    "recheck",
    "recheck",
    "recheck",
    "recheck",
    "objects",
    "recheck",
  ]),
);

it.effect("keeps the case pending and local data intact when R2 ownership is contradictory", () => {
  const calls: Array<string> = [];
  const candidate = {
    _tag: "SelfService" as const,
    agentId: AgentId.make("agent-1"),
    approvalActionId: ActionId.make("account-delete-1"),
    approvalPresentation: ApprovalPresentation.make("Delete Account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  const port = testPort({
    inspectAuthorization: () =>
      Effect.sync(() => calls.push("recheck")).pipe(Effect.as(activeFacts(candidate.userId))),
    agents: {
      quiesce: () => Effect.sync(() => calls.push("quiesce")),
      remove: () => Effect.sync(() => calls.push("agent")),
    },
    integrations: { pending: () => Effect.succeed([]), revoke: () => Effect.void },
    objects: {
      remove: () =>
        Effect.sync(() => calls.push("objects")).pipe(
          Effect.andThen(
            Effect.fail(
              new AccountDeletion.AccountDeletionUnavailable({
                cause: "contradictory attempt ownership",
                message: "R2 ownership evidence is invalid",
                operation: "removeObjects",
              }),
            ),
          ),
        ),
    },
    persistence: {
      ...passthroughIntegrationProgress,
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.sync(() => calls.push("postgres")).pipe(Effect.as(undefined)),
    },
  });

  return Effect.gen(function* () {
    const deletion = yield* AccountDeletion.Service;
    const result = yield* deletion.reconcileOne(candidate).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(yield* port.persistence.pending).toEqual([candidate]);
    expect(calls).toEqual([
      "recheck",
      "quiesce",
      "recheck",
      "provider",
      "recheck",
      "recheck",
      "recheck",
      "objects",
    ]);
  }).pipe(Effect.provide(accountDeletionLayer(port, calls, () => "deleted")));
});

it.effect("stops before PostgreSQL deletion when authority changes during Agent deletion", () =>
  expectStopsWhenAuthorityChangesAfter("agent", [
    "recheck",
    "quiesce",
    "recheck",
    "provider",
    "recheck",
    "recheck",
    "recheck",
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
    approvalPresentation: ApprovalPresentation.make("Delete Account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  const recordEffect = (operation: "agent" | "objects") =>
    Effect.sync(() => {
      calls.push(operation);
      if (changedAfter === operation) authorized = false;
    });
  const port = testPort({
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
      ...passthroughIntegrationProgress,
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
    approvalPresentation: ApprovalPresentation.make("Delete Account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  const port = testPort({
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
      ...passthroughIntegrationProgress,
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
    approvalPresentation: ApprovalPresentation.make("Delete Account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  const port = testPort({
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
      ...passthroughIntegrationProgress,
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.sync(() => calls.push("postgres")).pipe(Effect.as(undefined)),
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
      approvalPresentation: ApprovalPresentation.make("Delete Account"),
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
    const progress = new Map<
      AccountDeletion.IntegrationAuthorityTargetId,
      AccountDeletion.IntegrationAuthorityTargetProgress
    >();
    let firstConfirmationAttempts = 0;
    const port = testPort({
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
            return targets
              .filter((target) => target.userId === userId)
              .flatMap((target, index) => (index === 0 ? [target, target] : [target]));
          }),
        revoke: (target) =>
          Effect.suspend(() => {
            calls.push(target.connectionId);
            const index = targets.findIndex(
              ({ connectionId }) => connectionId === target.connectionId,
            );
            if (index >= 0) targets.splice(index, 1);
            return Effect.void;
          }),
      },
      objects: {
        remove: (_, authorizeDelete) =>
          authorizeDelete.pipe(Effect.andThen(Effect.sync(() => calls.push("objects")))),
      },
      persistence: {
        confirmIntegrationTarget: (_, target) =>
          Effect.suspend(() => {
            if (target.connectionId === "connection-1" && firstConfirmationAttempts === 0) {
              firstConfirmationAttempts += 1;
              return Effect.fail(
                new AccountDeletion.AccountDeletionUnavailable({
                  cause: target,
                  message: "Process stopped before durable target confirmation",
                  operation: "confirmIntegrationTarget",
                }),
              );
            }
            const retained = progress.get(target.connectionId);
            if (retained === undefined) {
              return Effect.die(new Error("Confirmed integration target was not staged"));
            }
            progress.set(target.connectionId, { ...retained, status: "confirmed" });
            return Effect.void;
          }),
        ensureAccessFence: () => Effect.void,
        pending: Effect.succeed([candidate]),
        removeUser: () => Effect.sync(() => calls.push("postgres")).pipe(Effect.as(undefined)),
        stageIntegrationTargets: (_, discovered) =>
          Effect.sync(() => {
            for (const target of discovered) {
              progress.set(target.connectionId, { ...target, status: "pending" });
            }
            return [...progress.values()].flatMap(({ connectionId, status, userId }) =>
              status === "pending" ? [{ connectionId, userId }] : [],
            );
          }),
      },
    });

    return Effect.gen(function* () {
      const reconcile = AccountDeletion.Service.pipe(
        Effect.flatMap((deletion) => deletion.reconcileOne(candidate)),
        Effect.provide(accountDeletionLayer(port, calls, () => "deleted")),
      );
      const first = yield* reconcile.pipe(Effect.result);
      expect(Result.isFailure(first)).toBe(true);
      expect(targets.map(({ connectionId }) => connectionId)).toEqual([
        "connection-2",
        "unrelated-connection",
      ]);

      yield* reconcile;
      expect(targets).toEqual([
        {
          connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("unrelated-connection"),
          userId: unrelatedUserId,
        },
      ]);
      expect(calls.filter((call) => call === "connection-1")).toHaveLength(2);
      expect(calls.filter((call) => call === "connection-2")).toHaveLength(1);
      expect(
        calls.every(
          (call, index) => !call.startsWith("connection-") || calls[index - 1] === "recheck",
        ),
      ).toBe(true);
      expect(calls).toContain("postgres");
    });
  },
);

it.effect("does not revoke a confirmed integration target after provider rediscovery", () => {
  const calls: Array<string> = [];
  const candidate = {
    _tag: "SelfService" as const,
    agentId: AgentId.make("agent-1"),
    approvalActionId: ActionId.make("account-delete-1"),
    approvalPresentation: ApprovalPresentation.make("Delete Account"),
    deletionCaseId: DeletionCaseId.make("deletion-case-1"),
    userId: UserId.make("user-1"),
  };
  const firstTarget = {
    connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("connection-1"),
    userId: candidate.userId,
  };
  const secondTarget = {
    connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("connection-2"),
    userId: candidate.userId,
  };
  const progress = new Map<
    AccountDeletion.IntegrationAuthorityTargetId,
    AccountDeletion.IntegrationAuthorityTargetProgress
  >();
  let failSecondRevocation = true;
  const port = testPort({
    inspectAuthorization: () => Effect.succeed(activeFacts(candidate.userId)),
    agents: {
      quiesce: () => Effect.void,
      remove: () => Effect.void,
    },
    integrations: {
      pending: () => Effect.succeed([firstTarget, secondTarget]),
      revoke: (target) =>
        Effect.suspend(() => {
          calls.push(`revoke:${target.connectionId}`);
          if (target.connectionId === secondTarget.connectionId && failSecondRevocation) {
            failSecondRevocation = false;
            return Effect.fail(
              new AccountDeletion.AccountDeletionUnavailable({
                cause: target,
                message: "Second integration revocation remains pending",
                operation: "deleteIntegrationAuthority",
              }),
            );
          }
          return Effect.void;
        }),
    },
    objects: { remove: (_, authorizeDelete) => authorizeDelete },
    persistence: {
      confirmIntegrationTarget: (_, target) =>
        Effect.sync(() => {
          calls.push(`confirm:${target.connectionId}`);
          progress.set(target.connectionId, { ...target, status: "confirmed" });
        }),
      ensureAccessFence: () => Effect.void,
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.void,
      stageIntegrationTargets: (_, discovered) =>
        Effect.sync(() => {
          for (const target of discovered) {
            if (!progress.has(target.connectionId)) {
              progress.set(target.connectionId, { ...target, status: "pending" });
            }
          }
          return [...progress.values()].flatMap(({ connectionId, status, userId }) =>
            status === "pending" ? [{ connectionId, userId }] : [],
          );
        }),
    },
  });

  return Effect.gen(function* () {
    const reconcile = AccountDeletion.Service.pipe(
      Effect.flatMap((deletion) => deletion.reconcileOne(candidate)),
      Effect.provide(accountDeletionLayer(port, calls, () => "deleted")),
    );
    expect(Result.isFailure(yield* reconcile.pipe(Effect.result))).toBe(true);
    yield* reconcile;
    expect(calls.filter((call) => call === "revoke:connection-1")).toHaveLength(1);
    expect(calls.filter((call) => call === "confirm:connection-1")).toHaveLength(1);
    expect(calls.filter((call) => call === "revoke:connection-2")).toHaveLength(2);
    expect(calls.filter((call) => call === "confirm:connection-2")).toHaveLength(1);
  });
});

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
  const port = testPort({
    inspectAuthorization: () =>
      Effect.sync(() => calls.push("recheck")).pipe(
        Effect.as({
          ...activeFacts(userId),
          administrativeAuthority: { adminActorId: candidate.adminActorId },
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
      ...passthroughIntegrationProgress,
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.sync(() => calls.push("postgres")).pipe(Effect.as(undefined)),
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
      "recheck",
      "recheck",
      "recheck",
      "objects",
      "recheck",
      "agent",
      "recheck",
      "postgres",
    ]);
  }).pipe(Effect.provide(accountDeletionLayer(port, calls, () => "deleted")));
});

it.effect("keeps an administrative case pending when its exact administrator is revoked", () => {
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
  let administratorActive = true;
  const port = testPort({
    inspectAuthorization: () =>
      Effect.sync(() => {
        calls.push("recheck");
        return administratorActive
          ? {
              ...activeFacts(userId),
              administrativeAuthority: { adminActorId: candidate.adminActorId },
            }
          : null;
      }),
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
      ...passthroughIntegrationProgress,
      pending: Effect.succeed([candidate]),
      removeUser: () => Effect.sync(() => calls.push("postgres")).pipe(Effect.as(undefined)),
    },
  });

  return Effect.gen(function* () {
    const deletion = yield* AccountDeletion.Service;
    const result = yield* deletion.reconcileOne(candidate).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(calls).toEqual(["recheck", "quiesce", "recheck", "provider", "recheck"]);
  }).pipe(
    Effect.provide(
      accountDeletionLayer(port, calls, () => {
        administratorActive = false;
        return "deleted";
      }),
    ),
  );
});

it.effect(
  "attempts durable cohort scrub dispatch without undoing completed product deletion",
  () => {
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
    const dispatch = qualificationCohortScrubDispatchIdentity("cohort", "execution");
    const port = testPort({
      inspectAuthorization: () =>
        Effect.succeed({
          ...activeFacts(userId),
          administrativeAuthority: { adminActorId: candidate.adminActorId },
        }),
      agents: { quiesce: () => Effect.void, remove: () => Effect.void },
      integrations: { pending: () => Effect.succeed([]), revoke: () => Effect.void },
      objects: { remove: (_, authorizeDelete) => authorizeDelete },
      persistence: {
        ...passthroughIntegrationProgress,
        pending: Effect.succeed([candidate]),
        removeUser: () =>
          Effect.sync(() => calls.push("postgres")).pipe(Effect.as([dispatch] as const)),
      },
      qualificationScrub: {
        dispatch: () =>
          Effect.sync(() => calls.push("dispatch")).pipe(
            Effect.andThen(
              Effect.fail(
                new AccountDeletion.AccountDeletionUnavailable({
                  cause: "lost Workflow create response",
                  message: "Qualification cohort scrub dispatch is unavailable",
                  operation: "dispatchQualificationCohortScrubRoot",
                }),
              ),
            ),
          ),
      },
    });

    return Effect.gen(function* () {
      const deletion = yield* AccountDeletion.Service;
      yield* deletion.reconcileOne(candidate);
      expect(calls).toEqual(["provider", "postgres", "dispatch"]);
    }).pipe(Effect.provide(accountDeletionLayer(port, calls, () => "deleted")));
  },
);

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
  administrativeAuthority: null,
  resourceOwnerUserId: userId,
  subscription: { plan: "free", planPolicyVersion: PlanPolicyVersion.make("launch-v1") },
  user: { _tag: "ActiveUser", userId },
});

const passthroughIntegrationProgress = {
  confirmIntegrationTarget: () => Effect.void,
  ensureAccessFence: () => Effect.void,
  stageIntegrationTargets: (
    _candidate: AccountDeletion.PendingAccountDeletion,
    targets: ReadonlyArray<AccountDeletion.IntegrationAuthorityTarget>,
  ) => Effect.succeed(targets),
};

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
      verifyUserKnowledge: () => Effect.succeed({ _tag: "AlreadyAbsent" as const }),
    }),
  );

const unexpectedMemoryProvider = {
  checkConversationSearchability: () =>
    Effect.die(new Error("unexpected conversation searchability check")),
  configureOrganizationGuidance: Effect.die(
    new Error("unexpected organization guidance configuration"),
  ),
  configureUserGuidance: () => Effect.die(new Error("unexpected User guidance configuration")),
  deleteSessionConversation: () => Effect.die(new Error("unexpected Session deletion")),
  findSessionConversation: () => Effect.die(new Error("unexpected Session discovery")),
  forgetKnowledge: () => Effect.die(new Error("unexpected forgetting")),
  getConversationStatus: () => Effect.die(new Error("unexpected status read")),
  recall: () => Effect.die(new Error("unexpected recall")),
  saveConversation: () => Effect.die(new Error("unexpected conversation save")),
  verifySessionConversation: () => Effect.die(new Error("unexpected Session verification")),
};
