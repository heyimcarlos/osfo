/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect is the entry point for its isolated service Layers. */
/* oxlint-disable eslint/no-underscore-dangle -- Assertions inspect canonical tagged outcomes. */
import { expect, it } from "@effect/vitest";
import { BrowserCrypto } from "@effect/platform-browser";
import { Deferred, Effect, Fiber, Option } from "effect";

import { Db } from "../../db";
import {
  AllowancePeriodId,
  AssistantMessageId,
  ResourcePriceVersion,
  SessionId,
  UserId,
} from "../../domain";
import { ActionId } from "../../domain/action-execution";
import { AuthSessionId } from "../../domain/auth-session";
import { ApprovalPresentation } from "../../services/authorization";
import { MemoryProvider } from "../../services/memory-provider";
import type {
  ClaimedMemoryProviderWork,
  MemoryProviderDeletionProgress,
  MemoryProviderOutboxStore,
} from "./db/memory-provider-outbox";
import { MemoryProviderOutboxId } from "./db/memory-provider-outbox";
import {
  ProviderDeletionDeferred,
  quiesceProcessingConversations,
  reconcileMemoryProviderOutbox,
} from "./memory-provider-reconciliation";

const documentId = MemoryProvider.ProviderDocumentId.make("document-1");
type ObservedSessionDeletion = MemoryProvider.DeleteSessionConversationInput & {
  readonly _tag: "DeleteSessionConversation";
};

it.effect("retries a rejected deletion until the provider confirms it", () => {
  const claim = authorizedDeletionClaim();
  const observed: Array<ObservedSessionDeletion> = [];
  const { completed, failed, retried, store } = testStore(claim);
  const provider = providerStub({
    deleteSessionConversation: (input) => {
      observed.push({ _tag: "DeleteSessionConversation", ...input });
      return Effect.fail(
        new MemoryProvider.MemoryProviderRejected({
          message: "Provider policy is temporarily inconsistent",
          operation: "deleteSessionConversation",
        }),
      );
    },
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store, permittedDeletionOptions)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(observed).toEqual([
          {
            _tag: "DeleteSessionConversation",
            documentId,
            sessionId: "session-1",
            userId: "user-1",
          },
        ]);
        expect(failed).toEqual([]);
        expect(retried).toEqual([claim.outboxId]);
        expect(completed).toEqual([]);
      }),
    ),
  );
});

it.effect("does not execute legacy User deletion outside the PostgreSQL Deletion Case", () => {
  const claim: ClaimedMemoryProviderWork = {
    ...deletionClaim(),
    payload: { _tag: "DeleteUserKnowledge", userId: UserId.make("user-1") },
  };
  let providerCalled = false;
  const { completed, failed, retried, store } = testStore(claim);
  const provider = providerStub({
    deleteUserKnowledge: () => {
      providerCalled = true;
      return Effect.succeed({ _tag: "Deleted" as const });
    },
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store, permittedDeletionOptions)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(providerCalled).toBe(false);
        expect(failed).toEqual([]);
        expect(retried).toEqual([claim.outboxId]);
        expect(completed).toEqual([]);
      }),
    ),
  );
});

it.effect("completes deletion work only after provider confirmation", () => {
  const claim = authorizedDeletionClaim();
  const observed: Array<ObservedSessionDeletion> = [];
  const { completed, retried, store } = testStore(claim);
  let verificationCount = 0;
  const provider = providerStub({
    deleteSessionConversation: (input) => {
      observed.push({ _tag: "DeleteSessionConversation", ...input });
      return Effect.succeed({ _tag: "Deleted" as const });
    },
    verifySessionConversation: () =>
      Effect.sync(() => {
        verificationCount += 1;
        return verificationCount === 1
          ? ({ _tag: "Verified" } as const)
          : ({ _tag: "AlreadyAbsent" } as const);
      }),
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store, permittedDeletionOptions)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(observed).toEqual([
          {
            _tag: "DeleteSessionConversation",
            documentId,
            sessionId: "session-1",
            userId: "user-1",
          },
        ]);
        expect(completed).toEqual([claim.outboxId]);
        expect(retried).toEqual([]);
        expect(verificationCount).toBe(2);
      }),
    ),
  );
});

it.effect("keeps Session deletion pending when DELETE 204 has not made the document absent", () => {
  const claim = authorizedDeletionClaim();
  let verificationCount = 0;
  const { completed, deletionProgress, retried, store } = testStore(claim);
  const provider = providerStub({
    deleteSessionConversation: () => Effect.succeed({ _tag: "Deleted" as const }),
    verifySessionConversation: () =>
      Effect.sync(() => {
        verificationCount += 1;
        return { _tag: "Verified" as const };
      }),
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store, permittedDeletionOptions)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(verificationCount).toBe(2);
        expect(completed).toEqual([]);
        expect(retried).toEqual([claim.outboxId]);
        expect(deletionProgress).toEqual([
          {
            _tag: "DeleteSessionConversation",
            awaitingDiscovery: false,
            targets: [{ documentId, status: "observed" }],
          },
        ]);
      }),
    ),
  );
});

it.effect("confirms delayed Session absence after restart without repeating DELETE", () => {
  const firstClaim = authorizedDeletionClaim();
  const firstRun = testStore(firstClaim);
  const firstProvider = providerStub({
    deleteSessionConversation: () => Effect.succeed({ _tag: "Deleted" as const }),
    verifySessionConversation: () => Effect.succeed({ _tag: "Verified" as const }),
  });
  const retainedClaim: ClaimedMemoryProviderWork = {
    ...firstClaim,
    deletionProgress: {
      _tag: "DeleteSessionConversation",
      awaitingDiscovery: false,
      targets: [{ documentId, status: "observed" }],
    },
  };
  const restarted = testStore(retainedClaim);
  let repeatedDelete = false;
  const restartedProvider = providerStub({
    deleteSessionConversation: () => {
      repeatedDelete = true;
      return Effect.die(new Error("Confirmed absence repeated provider deletion"));
    },
    verifySessionConversation: () => Effect.succeed({ _tag: "AlreadyAbsent" as const }),
  });

  return Effect.scoped(
    reconcileMemoryProviderOutbox(firstRun.store, permittedDeletionOptions).pipe(
      Effect.provideService(MemoryProvider.Service, firstProvider),
      Effect.andThen(
        reconcileMemoryProviderOutbox(restarted.store, permittedDeletionOptions).pipe(
          Effect.provideService(MemoryProvider.Service, restartedProvider),
        ),
      ),
    ),
  ).pipe(
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(firstRun.completed).toEqual([]);
        expect(firstRun.retried).toEqual([firstClaim.outboxId]);
        expect(restarted.completed).toEqual([retainedClaim.outboxId]);
        expect(restarted.retried).toEqual([]);
        expect(repeatedDelete).toBe(false);
      }),
    ),
  );
});

it.effect("keeps Session deletion pending when post-delete identity confirmation fails", () => {
  const claim = authorizedDeletionClaim();
  let verificationCount = 0;
  const { completed, retried, store } = testStore(claim);
  const provider = providerStub({
    deleteSessionConversation: () => Effect.succeed({ _tag: "Deleted" as const }),
    verifySessionConversation: () =>
      Effect.suspend(() => {
        verificationCount += 1;
        return verificationCount === 1
          ? Effect.succeed({ _tag: "Verified" as const })
          : Effect.fail(
              new MemoryProvider.MemoryProviderUnavailable({
                diagnostic: "identityMismatch",
                message: "The provider returned a different Session document",
                operation: "deleteSessionConversation",
              }),
            );
      }),
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store, permittedDeletionOptions)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(completed).toEqual([]);
        expect(retried).toEqual([claim.outboxId]);
      }),
    ),
  );
});

it.effect("rechecks retained Approval around idempotent local deletion preparation", () => {
  const claim = authorizedDeletionClaim();
  const events: Array<string> = [];
  let verificationCount = 0;
  const { completed, store } = testStore(claim);
  const provider = providerStub({
    deleteSessionConversation: () =>
      Effect.sync(() => {
        events.push("provider");
        return { _tag: "Deleted" as const };
      }),
    verifySessionConversation: () =>
      Effect.sync(() => {
        verificationCount += 1;
        return verificationCount === 1
          ? ({ _tag: "Verified" } as const)
          : ({ _tag: "AlreadyAbsent" } as const);
      }),
  });

  return Effect.scoped(
    reconcileMemoryProviderOutbox(store, {
      authorizeDeletion: () =>
        Effect.sync(() => {
          events.push("authorize");
          return { _tag: "Permitted" as const };
        }),
      prepareDeletion: () => Effect.sync(() => events.push("local")),
    }),
  ).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(events).toEqual([
          "authorize",
          "local",
          "authorize",
          "authorize",
          "authorize",
          "authorize",
          "provider",
          "authorize",
        ]);
        expect(completed).toEqual([claim.outboxId]);
      }),
    ),
  );
});

it.effect("retries retained deletion when asynchronous local preparation rejects", () => {
  const claim = authorizedDeletionClaim();
  let providerCalled = false;
  const { completed, retried, store } = testStore(claim);
  const provider = providerStub({
    deleteSessionConversation: () => {
      providerCalled = true;
      return Effect.succeed({ _tag: "Deleted" as const });
    },
  });

  return Effect.scoped(
    reconcileMemoryProviderOutbox(store, {
      authorizeDeletion: () => Effect.succeed({ _tag: "Permitted" as const }),
      prepareDeletion: () =>
        Effect.tryPromise({
          try: () => Promise.reject(new Error("Injected Session settlement rejection")),
          catch: (cause) =>
            new ProviderDeletionDeferred({
              cause,
              message: "Local Session deletion remains pending",
            }),
        }),
    }),
  ).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(providerCalled).toBe(false);
        expect(retried).toEqual([claim.outboxId]);
        expect(completed).toEqual([]);
      }),
    ),
  );
});

it.effect("persists each forgotten memory before rechecking authority for the next target", () => {
  const claim = authorizedForgetKnowledgeClaim();
  const events: Array<string> = [];
  let checks = 0;
  const { deletionProgress, completed, retried, store } = testStore(claim);
  const provider = providerStub({
    forgetKnowledge: ({ memoryId }) =>
      Effect.sync(() => {
        events.push(`forget:${memoryId}`);
        return { _tag: "Deleted" as const };
      }),
  });

  return Effect.scoped(
    reconcileMemoryProviderOutbox(store, {
      authorizeDeletion: () =>
        Effect.sync(() => {
          checks += 1;
          events.push(`authorize:${checks}`);
          return checks < 4
            ? ({ _tag: "Permitted" } as const)
            : ({ _tag: "Denied", reason: "authorityRevoked", resetAt: null } as const);
        }),
      prepareDeletion: () => Effect.void,
    }),
  ).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(events).toEqual([
          "authorize:1",
          "authorize:2",
          "authorize:3",
          "forget:memory-1",
          "authorize:4",
        ]);
        expect(deletionProgress).toEqual([
          { _tag: "ForgetKnowledge", coreMemoryState: "refreshed", completedMemoryIds: [] },
          {
            _tag: "ForgetKnowledge",
            coreMemoryState: "refreshed",
            completedMemoryIds: ["memory-1"],
          },
        ]);
        expect(retried).toEqual([claim.outboxId]);
        expect(completed).toEqual([]);
      }),
    ),
  );
});

it.effect("does not repeat a durably completed Core Memory correction on provider retry", () => {
  const claim: ClaimedMemoryProviderWork = {
    ...authorizedForgetKnowledgeClaim(),
    deletionProgress: {
      _tag: "ForgetKnowledge",
      coreMemoryState: "refreshed",
      completedMemoryIds: [],
    },
  };
  let coreMemory = "A newer User edit after the original correction";
  const { completed, store } = testStore(claim);
  const provider = providerStub({
    forgetKnowledge: () => Effect.succeed({ _tag: "Deleted" as const }),
  });

  return Effect.scoped(
    reconcileMemoryProviderOutbox(store, {
      authorizeDeletion: permittedDeletionOptions.authorizeDeletion,
      prepareDeletion: () =>
        Effect.sync(() => {
          coreMemory = "The older retained correction";
        }),
    }),
  ).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(coreMemory).toBe("A newer User edit after the original correction");
        expect(completed).toEqual([claim.outboxId]);
      }),
    ),
  );
});

it.effect(
  "retries prompt refresh after correction commit without applying retained rows again",
  () => {
    const claim: ClaimedMemoryProviderWork = {
      ...authorizedForgetKnowledgeClaim(),
      deletionProgress: {
        _tag: "ForgetKnowledge",
        coreMemoryState: "committed",
        completedMemoryIds: [],
      },
    };
    const coreMemory = "A newer User edit after the atomic correction committed";
    let refreshAttempts = 0;
    const { completed, deletionProgress, store } = testStore(claim);
    const provider = providerStub({
      forgetKnowledge: () => Effect.succeed({ _tag: "Deleted" as const }),
    });

    return Effect.scoped(
      reconcileMemoryProviderOutbox(store, {
        authorizeDeletion: permittedDeletionOptions.authorizeDeletion,
        prepareDeletion: () =>
          Effect.sync(() => {
            refreshAttempts += 1;
          }),
      }),
    ).pipe(
      Effect.provideService(MemoryProvider.Service, provider),
      Effect.provideService(Db.Service, unavailableDatabase),
      Effect.provide(BrowserCrypto.layer),
      Effect.andThen(
        Effect.sync(() => {
          expect(coreMemory).toBe("A newer User edit after the atomic correction committed");
          expect(refreshAttempts).toBe(1);
          expect(deletionProgress).toEqual([
            { _tag: "ForgetKnowledge", coreMemoryState: "refreshed", completedMemoryIds: [] },
            {
              _tag: "ForgetKnowledge",
              coreMemoryState: "refreshed",
              completedMemoryIds: ["memory-1"],
            },
            {
              _tag: "ForgetKnowledge",
              coreMemoryState: "refreshed",
              completedMemoryIds: ["memory-1", "memory-2"],
            },
          ]);
          expect(completed).toEqual([claim.outboxId]);
        }),
      ),
    );
  },
);

it.effect("retries Core Memory correction when legacy progress does not prove completion", () => {
  const claim = authorizedForgetKnowledgeClaim();
  let correctionAttempts = 0;
  const { completed, store } = testStore(claim);
  const provider = providerStub({
    forgetKnowledge: () => Effect.succeed({ _tag: "Deleted" as const }),
  });

  return Effect.scoped(
    reconcileMemoryProviderOutbox(store, {
      authorizeDeletion: permittedDeletionOptions.authorizeDeletion,
      prepareDeletion: () =>
        Effect.sync(() => {
          correctionAttempts += 1;
        }),
    }),
  ).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(correctionAttempts).toBe(1);
        expect(completed).toEqual([claim.outboxId]);
      }),
    ),
  );
});

it.effect("does not complete forgotten Knowledge when provider identity confirmation fails", () => {
  const claim = authorizedForgetKnowledgeClaim();
  const { completed, deletionProgress, retried, store } = testStore(claim);
  const provider = providerStub({
    forgetKnowledge: () =>
      Effect.fail(
        new MemoryProvider.MemoryProviderUnavailable({
          diagnostic: "identityMismatch",
          message: "The MemoryProvider confirmed a different Knowledge memory",
          operation: "forgetKnowledge",
        }),
      ),
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store, permittedDeletionOptions)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(completed).toEqual([]);
        expect(deletionProgress).toEqual([
          { _tag: "ForgetKnowledge", coreMemoryState: "refreshed", completedMemoryIds: [] },
        ]);
        expect(retried).toEqual([claim.outboxId]);
      }),
    ),
  );
});

it.effect("rechecks authority between Session discovery and ownership verification", () => {
  const claim = authorizedDeletionClaim();
  const events: Array<string> = [];
  let checks = 0;
  const { deletionProgress, completed, retried, store } = testStore(claim);
  const provider = providerStub({
    findSessionConversation: () =>
      Effect.sync(() => {
        events.push("list");
        return { _tag: "Found" as const, documentIds: [documentId] };
      }),
    verifySessionConversation: () => Effect.die(new Error("Stale authority reached GET")),
  });

  return Effect.scoped(
    reconcileMemoryProviderOutbox(store, {
      authorizeDeletion: () =>
        Effect.sync(() => {
          checks += 1;
          events.push(`authorize:${checks}`);
          return checks < 4
            ? ({ _tag: "Permitted" } as const)
            : ({ _tag: "Denied", reason: "authorityRevoked", resetAt: null } as const);
        }),
      prepareDeletion: () => Effect.void,
    }),
  ).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(events).toEqual([
          "authorize:1",
          "authorize:2",
          "authorize:3",
          "list",
          "authorize:4",
        ]);
        expect(deletionProgress).toEqual([
          {
            _tag: "DeleteSessionConversation",
            awaitingDiscovery: false,
            targets: [{ documentId, status: "observed" }],
          },
        ]);
        expect(retried).toEqual([claim.outboxId]);
        expect(completed).toEqual([]);
      }),
    ),
  );
});

it.effect("rechecks authority between Session ownership verification and deletion", () => {
  const claim = authorizedDeletionClaim();
  const events: Array<string> = [];
  let checks = 0;
  const { completed, retried, store } = testStore(claim);
  const provider = providerStub({
    findSessionConversation: () =>
      Effect.sync(() => {
        events.push("list");
        return { _tag: "Found" as const, documentIds: [documentId] };
      }),
    verifySessionConversation: () =>
      Effect.sync(() => {
        events.push("get");
        return { _tag: "Verified" as const };
      }),
    deleteSessionConversation: () => Effect.die(new Error("Stale authority reached DELETE")),
  });

  return Effect.scoped(
    reconcileMemoryProviderOutbox(store, {
      authorizeDeletion: () =>
        Effect.sync(() => {
          checks += 1;
          events.push(`authorize:${checks}`);
          return checks < 5
            ? ({ _tag: "Permitted" } as const)
            : ({ _tag: "Denied", reason: "authorityRevoked", resetAt: null } as const);
        }),
      prepareDeletion: () => Effect.void,
    }),
  ).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(events).toEqual([
          "authorize:1",
          "authorize:2",
          "authorize:3",
          "list",
          "authorize:4",
          "get",
          "authorize:5",
        ]);
        expect(retried).toEqual([claim.outboxId]);
        expect(completed).toEqual([]);
      }),
    ),
  );
});

it.effect("retains the exact conversation snapshot after an ambiguous provider outage", () => {
  const claim = conversationClaim();
  const observed: Array<MemoryProvider.SaveConversationInput> = [];
  const { ambiguous, completed, retried, store } = testStore(claim);
  const provider = providerStub({
    saveConversation: (input) => {
      observed.push(input);
      return Effect.fail(
        new MemoryProvider.MemoryProviderUnavailable({
          message: "Provider is unavailable",
          operation: "saveConversation",
        }),
      );
    },
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store, permittedDeletionOptions)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(observed).toEqual([
          {
            conversation: MemoryProvider.ConversationSnapshot.make({
              messages: [
                { content: "Remember this", role: "user" },
                { content: "I will remember it", role: "assistant" },
              ],
              usageStartIndex: 0,
            }),
            sessionId: "session-1",
            userId: "user-1",
          },
        ]);
        expect(ambiguous).toEqual([claim.outboxId]);
        expect(retried).toEqual([]);
        expect(completed).toEqual([]);
      }),
    ),
  );
});

it.effect("does not start a provider append after account deletion fences the User", () => {
  const claim = conversationClaim();
  let providerCalled = false;
  const { completed, retried, store } = testStore(claim);
  const provider = providerStub({
    saveConversation: () => {
      providerCalled = true;
      return Effect.die(new Error("Account-fenced conversation reached the provider"));
    },
  });

  return Effect.scoped(
    reconcileMemoryProviderOutbox(store, {
      ...permittedDeletionOptions,
      canSaveConversation: () => Effect.succeed(false),
    }),
  ).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(providerCalled).toBe(false);
        expect(retried).toEqual([claim.outboxId]);
        expect(completed).toEqual([]);
      }),
    ),
  );
});

it.effect("rechecks a claimed append after Session deletion terminalizes it", () =>
  Effect.gen(function* () {
    const claim = conversationClaim();
    const checkedDeletionFence = yield* Deferred.make<void>();
    const continueAfterDeletion = yield* Deferred.make<void>();
    let claimIsCurrent = true;
    let providerCalled = false;
    const { completed, retried, store: baseStore } = testStore(claim);
    const store = {
      ...baseStore,
      isClaimCurrent: () => Effect.sync(() => claimIsCurrent),
    };
    const provider = providerStub({
      saveConversation: () => {
        providerCalled = true;
        return Effect.die(new Error("A terminalized Session append reached the provider"));
      },
    });
    const reconciliation = Effect.scoped(
      reconcileMemoryProviderOutbox(store, {
        ...permittedDeletionOptions,
        canSaveConversation: () =>
          Deferred.succeed(checkedDeletionFence, undefined).pipe(
            Effect.andThen(Deferred.await(continueAfterDeletion)),
            Effect.as(true),
          ),
      }),
    ).pipe(
      Effect.provideService(MemoryProvider.Service, provider),
      Effect.provideService(Db.Service, unavailableDatabase),
      Effect.provide(BrowserCrypto.layer),
    );
    const fiber = yield* reconciliation.pipe(Effect.forkChild);

    yield* Deferred.await(checkedDeletionFence);
    claimIsCurrent = false;
    yield* Deferred.succeed(continueAfterDeletion, undefined);
    yield* Fiber.join(fiber);

    expect(providerCalled).toBe(false);
    expect(retried).toEqual([]);
    expect(completed).toEqual([]);
  }),
);

it.effect("configures organization and User guidance before first ingest", () => {
  const claim = conversationClaim();
  const calls: Array<string> = [];
  const { completed, retried, store } = testStore(claim, { configurationCurrent: false });
  const provider = providerStub({
    configureOrganizationGuidance: Effect.sync(() => {
      calls.push("organization");
    }),
    configureUserGuidance: () =>
      Effect.sync(() => {
        calls.push("user");
      }),
    saveConversation: () =>
      Effect.sync(() => {
        calls.push("save");
        return {
          documentId: MemoryProvider.ProviderDocumentId.make("document-1"),
          processingStatus: "processing" as const,
          usage: providerUsage,
        };
      }),
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store, permittedDeletionOptions)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(calls).toEqual(["organization", "user", "save"]);
        expect(retried).toEqual([]);
        expect(completed).toEqual([]);
      }),
    ),
  );
});

it.effect("does not ingest when the User container cannot be configured", () => {
  const claim = conversationClaim();
  const calls: Array<string> = [];
  const { completed, retried, store } = testStore(claim, { configurationCurrent: false });
  const provider = providerStub({
    configureOrganizationGuidance: Effect.sync(() => {
      calls.push("organization");
    }),
    configureUserGuidance: () => {
      calls.push("user");
      return Effect.fail(
        new MemoryProvider.MemoryProviderUnavailable({
          message: "The MemoryProvider did not upsert the User container",
          operation: "configureUserGuidance",
          status: 404,
        }),
      );
    },
    saveConversation: () => {
      calls.push("save");
      return Effect.succeed({
        documentId: MemoryProvider.ProviderDocumentId.make("document-1"),
        processingStatus: "processing",
        usage: providerUsage,
      });
    },
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store, permittedDeletionOptions)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(calls).toEqual(["organization", "user"]);
        expect(retried).toEqual([claim.outboxId]);
        expect(completed).toEqual([]);
      }),
    ),
  );
});

it.effect("retains an ambiguous provider submission until its claim lease expires", () => {
  const claim = conversationClaim();
  const { ambiguous, completed, failed, retried, store } = testStore(claim);
  const provider = providerStub({
    saveConversation: () =>
      Effect.fail(
        new MemoryProvider.MemoryProviderUnavailable({
          message: "The provider response was lost",
          operation: "saveConversation",
        }),
      ),
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store, permittedDeletionOptions)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(ambiguous).toEqual([claim.outboxId]);
        expect(retried).toEqual([]);
        expect(failed).toEqual([]);
        expect(completed).toEqual([]);
      }),
    ),
  );
});

it.effect("waits for an accepted provider conversation to leave processing", () => {
  const events: Array<string> = [];
  let processing = true;
  const { store: base } = testStore(conversationClaim());
  const store: MemoryProviderOutboxStore = {
    ...base,
    expediteProcessingConversationWork: () => Effect.sync(() => events.push("expedite")),
    hasUnsettledProviderConversationWork: Effect.sync(() => processing),
  };

  return quiesceProcessingConversations(
    store,
    () =>
      Effect.sync(() => {
        events.push("status");
        processing = false;
      }),
    1,
  ).pipe(
    Effect.andThen(
      Effect.sync(() => {
        expect(events).toEqual(["expedite", "status"]);
      }),
    ),
  );
});

it.effect("repairs organization guidance for a conversation accepted before migration", () => {
  const base = conversationClaim();
  const claim: ClaimedMemoryProviderWork = {
    ...base,
    providerAcceptance: {
      documentId: MemoryProvider.ProviderDocumentId.make("document-1"),
      processingStatus: "processing",
    },
    usage: providerUsage,
  };
  const calls: Array<string> = [];
  const { completed, store } = testStore(claim, { configurationCurrent: false });
  const provider = providerStub({
    configureOrganizationGuidance: Effect.sync(() => {
      calls.push("organization");
    }),
    configureUserGuidance: () =>
      Effect.sync(() => {
        calls.push("user");
      }),
    getConversationStatus: () =>
      Effect.sync(() => {
        calls.push("status");
        return { processingStatus: "done" as const };
      }),
    checkConversationSearchability: () =>
      Effect.sync(() => {
        calls.push("search");
        return true;
      }),
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store, permittedDeletionOptions)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(calls).toEqual(["organization", "user", "status", "search"]);
        expect(completed).toEqual([claim.outboxId]);
      }),
    ),
  );
});

it.effect("retains an indexed conversation until hybrid search returns its document", () => {
  const base = conversationClaim();
  const claim: ClaimedMemoryProviderWork = {
    ...base,
    providerAcceptance: {
      documentId: MemoryProvider.ProviderDocumentId.make("document-1"),
      processingStatus: "done",
    },
    usage: providerUsage,
  };
  const observed: Array<MemoryProvider.CheckConversationSearchabilityInput> = [];
  const { awaited, completed, store } = testStore(claim);
  const provider = providerStub({
    checkConversationSearchability: (input) => {
      observed.push(input);
      return Effect.succeed(false);
    },
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store, permittedDeletionOptions)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(observed).toEqual([{ expectedSource: "Remember this", userId: "user-1" }]);
        expect(awaited).toEqual(["done"]);
        expect(completed).toEqual([]);
      }),
    ),
  );
});

it.effect("terminalizes an accepted conversation whose provider status is invalid", () => {
  const claim = conversationClaim();
  const { completed, failed, retried, store } = testStore(claim);
  const provider = providerStub({
    saveConversation: () =>
      Effect.fail(
        new MemoryProvider.MemoryProviderAcceptanceStatusInvalid({
          documentId: MemoryProvider.ProviderDocumentId.make("document-1"),
          message: "The MemoryProvider accepted the conversation with an invalid status",
          operation: "saveConversation",
          usage: providerUsage,
        }),
      ),
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store, permittedDeletionOptions)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(failed).toEqual([claim.outboxId]);
        expect(retried).toEqual([]);
        expect(completed).toEqual([]);
      }),
    ),
  );
});

it.effect("stops when a stale conversation claim loses settlement ownership", () => {
  const claim = conversationClaim();
  const { completed, retried, store } = testStore(claim, { providerAccepted: false });
  const provider = providerStub({
    saveConversation: () =>
      Effect.succeed({
        documentId: MemoryProvider.ProviderDocumentId.make("document-1"),
        processingStatus: "processing",
        usage: providerUsage,
      }),
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store, permittedDeletionOptions)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(completed).toEqual([]);
        expect(retried).toEqual([]);
      }),
    ),
  );
});

const deletionAuthorization = {
  actionId: ActionId.make("action-1"),
  authorityIdentity: {
    _tag: "AuthSession" as const,
    authSessionId: AuthSessionId.make("auth-session-1"),
    userId: UserId.make("user-1"),
  },
  operation: "session.delete" as const,
  presentation: ApprovalPresentation.make("Delete Session session-1"),
};

const deletionClaim = (): ClaimedMemoryProviderWork => ({
  allowancePeriodId: null,
  attemptCount: 1,
  claimToken: "claim-1",
  outboxId: MemoryProviderOutboxId.make("deletion:session-1"),
  payload: {
    _tag: "DeleteSessionConversation",
    authorization: deletionAuthorization,
    sessionId: SessionId.make("session-1"),
    userId: UserId.make("user-1"),
  },
  providerAcceptance: null,
  sequence: 1,
  usage: null,
});

const authorizedDeletionClaim = (): ClaimedMemoryProviderWork => ({
  ...deletionClaim(),
});

const authorizedForgetKnowledgeClaim = (): ClaimedMemoryProviderWork => {
  const authorization = authorizedDeletionClaim().payload;
  if (authorization._tag !== "DeleteSessionConversation") throw new Error("Invalid fixture");
  return {
    ...authorizedDeletionClaim(),
    outboxId: MemoryProviderOutboxId.make("deletion:forget-1"),
    payload: {
      _tag: "ForgetKnowledge",
      authorization: authorization.authorization,
      coreMemory: [{ block: "userContext", content: "Forget selected knowledge" }],
      memoryIds: [
        MemoryProvider.KnowledgeMemoryId.make("memory-1"),
        MemoryProvider.KnowledgeMemoryId.make("memory-2"),
      ],
      userId: UserId.make("user-1"),
    },
  };
};

const conversationClaim = (): ClaimedMemoryProviderWork => ({
  allowancePeriodId: AllowancePeriodId.make("allowance-1"),
  attemptCount: 1,
  claimToken: "claim-append-1",
  outboxId: MemoryProviderOutboxId.make("conversation:9:session-1:assistant-1"),
  payload: {
    _tag: "SaveConversation",
    projection: {
      allowancePeriodId: AllowancePeriodId.make("allowance-1"),
      conversation: MemoryProvider.ConversationSnapshot.make({
        messages: [
          { content: "Remember this", role: "user" },
          { content: "I will remember it", role: "assistant" },
        ],
        usageStartIndex: 0,
      }),
      lastMessageId: AssistantMessageId.make("assistant-1"),
      sessionId: SessionId.make("session-1"),
      userId: UserId.make("user-1"),
    },
  },
  providerAcceptance: null,
  sequence: 1,
  usage: null,
});

const permittedDeletionOptions = {
  authorizeDeletion: () => Effect.succeed({ _tag: "Permitted" as const }),
  prepareDeletion: () => Effect.void,
};

const testStore = (
  claim: ClaimedMemoryProviderWork,
  options: {
    readonly configurationCurrent?: boolean;
    readonly providerAccepted?: boolean;
  } = {},
) => {
  const failed: Array<MemoryProviderOutboxId> = [];
  const completed: Array<MemoryProviderOutboxId> = [];
  const retried: Array<MemoryProviderOutboxId> = [];
  const awaited: Array<MemoryProvider.ConversationProcessingStatus> = [];
  const deletionProgress: Array<MemoryProviderDeletionProgress> = [];
  const ambiguous: Array<MemoryProviderOutboxId> = [];
  let available = true;
  const store = {
    awaitProvider: (
      _work: ClaimedMemoryProviderWork,
      status: MemoryProvider.ConversationProcessingStatus,
    ) =>
      Effect.sync(() => {
        awaited.push(status);
        return true;
      }),
    beginProviderSubmission: () => Effect.succeed(true),
    claimNext: () =>
      Effect.sync(() => {
        if (!available) return Option.none<ClaimedMemoryProviderWork>();
        available = false;
        return Option.some(claim);
      }),
    complete: (work: ClaimedMemoryProviderWork) =>
      Effect.sync(() => {
        completed.push(work.outboxId);
        return true;
      }),
    completeConfiguration: () => Effect.succeed(true),
    cancelDeletionPreparation: () => Effect.succeed(false),
    // oxlint-disable-next-line effecttsgo/sync-to-succeed -- The exact undefined return matches the store contract; Effect.void widens it to void.
    enqueueDeletion: () => Effect.sync(() => undefined),
    fail: (work: ClaimedMemoryProviderWork) =>
      Effect.sync(() => {
        failed.push(work.outboxId);
        return true;
      }),
    failProviderAcceptance: (work: ClaimedMemoryProviderWork) =>
      Effect.sync(() => {
        failed.push(work.outboxId);
        return true;
      }),
    expediteProcessingConversationWork: () => Effect.void,
    hasUnsettledProviderConversationWork: Effect.succeed(false),
    hasRetryableWork: Effect.succeed(false),
    inspectConfiguration: () => Effect.succeed(Option.none()),
    isClaimCurrent: () => Effect.succeed(true),
    markProviderAccepted: () => Effect.succeed(options.providerAccepted ?? true),
    markForgetKnowledgeCorrectionCommitted: () => true,
    markProviderStatus: () => Effect.succeed(true),
    readRecentTurnBridge: () => Effect.succeed([]),
    releaseDeletionPreparation: () => Effect.succeed(false),
    recordDeletionProgress: (_work, progress) =>
      Effect.sync(() => {
        deletionProgress.push(progress);
        return true;
      }),
    retainAmbiguousProviderSubmission: (work: ClaimedMemoryProviderWork) =>
      Effect.sync(() => {
        ambiguous.push(work.outboxId);
        return true;
      }),
    retainDeletionPreparation: () => Effect.succeed(Option.none()),
    retry: (work: ClaimedMemoryProviderWork) =>
      Effect.sync(() => {
        retried.push(work.outboxId);
        return true;
      }),
    requireConfiguration: () => Effect.succeed(options.configurationCurrent ?? true),
  } satisfies MemoryProviderOutboxStore;
  return { ambiguous, awaited, completed, deletionProgress, failed, retried, store };
};

const providerStub = (overrides: Partial<MemoryProvider.Interface>): MemoryProvider.Interface => ({
  checkConversationSearchability: () =>
    Effect.die(new Error("Unexpected conversation searchability check")),
  configureOrganizationGuidance: Effect.die(
    new Error("Unexpected organization guidance configuration"),
  ),
  configureUserGuidance: () => Effect.die(new Error("Unexpected User guidance configuration")),
  deleteSessionConversation: () => Effect.die(new Error("Unexpected Session deletion")),
  deleteUserKnowledge: () => Effect.die(new Error("Unexpected User deletion")),
  findSessionConversation: () =>
    Effect.succeed({
      _tag: "Found",
      documentIds: [MemoryProvider.ProviderDocumentId.make("document-1")],
    }),
  forgetKnowledge: () => Effect.die(new Error("Unexpected forget")),
  getConversationStatus: () => Effect.die(new Error("Unexpected conversation status read")),
  recall: () => Effect.die(new Error("Unexpected recall")),
  saveConversation: () => Effect.die(new Error("Unexpected conversation save")),
  verifySessionConversation: () => Effect.succeed({ _tag: "Verified" }),
  verifyUserKnowledge: () => Effect.die(new Error("Unexpected User verification")),
  ...overrides,
});

const providerUsage: MemoryProvider.UsageEvidence = {
  completedNonModelCost: [
    {
      activity: "conversationsAndMemory",
      ratedCostUsdMicros: 1n,
      resourcePriceVersion: ResourcePriceVersion.make("resource-prices-2026-08-22"),
    },
  ],
};

const unavailableDatabase: Db.Interface = {
  database: Effect.die(new Error("Unexpected PostgreSQL access")),
};
