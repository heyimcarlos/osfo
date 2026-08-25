/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect is the entry point for its isolated service Layer. */
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";

import { AgentId, UserId } from "../domain";
import { ActionId } from "../domain/action-execution";
import { AccountDeletion } from "./account-deletion";
import { ApprovalPresentation } from "./authorization";
import { MemoryProvider } from "./memory-provider";

it.effect("keeps local data pending until provider deletion confirms permanent absence", () => {
  const calls: Array<string> = [];
  const candidate = {
    agentId: AgentId.make("agent-1"),
    approvalActionId: ActionId.make("account-delete-1"),
    approvalPresentation: ApprovalPresentation.make("Delete account"),
    userId: UserId.make("user-1"),
  };
  const deletion = AccountDeletion.make({
    authorize: () => Effect.sync(() => calls.push("authorize")).pipe(Effect.as(true)),
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
    const unavailable = yield* deletion
      .reconcileOne(candidate)
      .pipe(Effect.provide(providerLayer("unavailable", calls)), Effect.result);
    expect(Result.isFailure(unavailable)).toBe(true);
    expect(calls).toEqual(["authorize", "quiesce", "authorize", "provider"]);

    yield* deletion.reconcileOne(candidate).pipe(Effect.provide(providerLayer("deleted", calls)));
    expect(calls).toEqual([
      "authorize",
      "quiesce",
      "authorize",
      "provider",
      "authorize",
      "quiesce",
      "authorize",
      "provider",
      "objects",
      "agent",
      "postgres",
    ]);
  });
});

it.effect("does not delete provider knowledge when authority changes during quiescence", () => {
  const calls: Array<string> = [];
  let checks = 0;
  const candidate = {
    agentId: AgentId.make("agent-1"),
    approvalActionId: ActionId.make("account-delete-1"),
    approvalPresentation: ApprovalPresentation.make("Delete account"),
    userId: UserId.make("user-1"),
  };
  const deletion = AccountDeletion.make({
    authorize: () =>
      Effect.sync(() => {
        calls.push("authorize");
        checks += 1;
        return checks === 1;
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

  return deletion.reconcileOne(candidate).pipe(
    Effect.provide(providerLayer("deleted", calls)),
    Effect.result,
    Effect.andThen(
      Effect.sync(() => {
        expect(calls).toEqual(["authorize", "quiesce", "authorize"]);
      }),
    ),
  );
});

const providerLayer = (result: "deleted" | "unavailable", calls: Array<string>) =>
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
        return result === "deleted"
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
