import { Context, DateTime, Effect, Layer, Predicate, Schema } from "effect";

import type { AgentId, PlanPolicyVersion, UserId } from "../domain";
import type { ActionId } from "../domain/action-execution";
import type { DeletionCaseId } from "../domain/deletion-case";
import type { UserAccessFact } from "../domain/user-suspension";
import { retainedCatalog } from "../domain/plan-policy";
import {
  approvalFor,
  type ApprovalPresentation,
  Authorization,
  AuthorizationContext,
  emptyLiveResourceFacts,
} from "./authorization";
import { MemoryProvider } from "./memory-provider";

/** One fenced account still carrying a durable deletion obligation. */
export interface PendingAccountDeletion {
  readonly agentId: AgentId | null;
  readonly approvalActionId: ActionId;
  readonly approvalPresentation: ApprovalPresentation;
  readonly deletionCaseId: DeletionCaseId;
  readonly userId: UserId;
}

/** Current mutable facts retained outside the durable Deletion Case authority. */
export interface CurrentAuthorizationFacts {
  readonly resourceOwnerUserId: UserId;
  readonly subscription: {
    readonly plan: "adventurer" | "free";
    readonly planPolicyVersion: PlanPolicyVersion;
  };
  readonly user: UserAccessFact;
}

/** Classified retryable failure in the broader account deletion flow. */
export class AccountDeletionUnavailable extends Schema.TaggedError<AccountDeletionUnavailable>()(
  "AccountDeletionUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

/** Deletion-owned boundaries applied only after provider knowledge confirms permanent absence. */
export interface PortInterface {
  /** Read current facts only while the exact self-service Deletion Case remains authoritative. */
  readonly inspectAuthorization: (
    candidate: PendingAccountDeletion,
  ) => Effect.Effect<CurrentAuthorizationFacts | null, AccountDeletionUnavailable>;
  readonly agents: {
    /** Fence new provider appends and wait for any provider append already in flight. */
    readonly quiesce: (
      agentId: AgentId,
      userId: UserId,
    ) => Effect.Effect<void, AccountDeletionUnavailable>;
    readonly remove: (agentId: AgentId) => Effect.Effect<void, AccountDeletionUnavailable>;
  };
  readonly objects: {
    readonly remove: (userId: UserId) => Effect.Effect<void, AccountDeletionUnavailable>;
  };
  readonly persistence: {
    readonly pending: Effect.Effect<
      ReadonlyArray<PendingAccountDeletion>,
      AccountDeletionUnavailable
    >;
    readonly removeUser: (userId: UserId) => Effect.Effect<void, AccountDeletionUnavailable>;
  };
}

/** Runtime boundaries owned by the account-deletion workflow. */
export class Port extends Context.Service<Port, PortInterface>()("@osfo/AccountDeletion/Port") {}

/** Caller-oriented account-deletion capability. */
export interface Interface {
  readonly reconcileOne: (
    candidate: PendingAccountDeletion,
  ) => Effect.Effect<void, AccountDeletionUnavailable>;
  readonly reconcilePending: Effect.Effect<void, AccountDeletionUnavailable>;
  readonly reconcileUser: (userId: UserId) => Effect.Effect<void, AccountDeletionUnavailable>;
}

/** Shared provider-first account-deletion service. */
export class Service extends Context.Service<Service, Interface>()("@osfo/AccountDeletion") {}

/** Construct the idempotent provider-first account deletion reconciler. */
export const make = Effect.gen(function* () {
  const dependencies = yield* Port;
  const provider = yield* MemoryProvider.Service;

  const recheck = Effect.fn("AccountDeletion.recheck")(function* (
    candidate: PendingAccountDeletion,
  ) {
    const facts = yield* dependencies.inspectAuthorization(candidate);
    if (facts === null) return false;
    const operation = {
      actionId: candidate.approvalActionId,
      kind: "account.delete",
    } as const;
    const triggerId = candidate.deletionCaseId;
    const authority = {
      _tag: "DurableTrigger",
      triggerId,
      triggerType: "deletionCase",
      userId: candidate.userId,
    } as const;
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    const result = Authorization.make(retainedCatalog).recheck(
      AuthorizationContext.make({
        allowance: { _tag: "Unavailable" },
        approval: approvalFor(candidate.userId, operation, candidate.approvalPresentation),
        authority,
        deletionAccess: { _tag: "DeletionAccessRevoked" },
        gmailConnection: null,
        integrationConnections: [],
        liveFacts: emptyLiveResourceFacts,
        now,
        originatingAuthority: {
          _tag: "DurableTrigger",
          triggerId,
          triggerType: "deletionCase",
        },
        requestVendorUsdMicros: 0n,
        resourceOwnerUserId: facts.resourceOwnerUserId,
        subscription: facts.subscription,
        user: facts.user,
      }),
      operation,
    );
    return Predicate.isTagged(result, "Permitted");
  });

  const reconcileOne = Effect.fn("AccountDeletion.reconcileOne")(function* (
    candidate: PendingAccountDeletion,
  ) {
    const requireCurrentAuthority = (changedDuring: string) =>
      recheck(candidate).pipe(
        Effect.filterOrFail(
          (authorized) => authorized,
          () =>
            new AccountDeletionUnavailable({
              cause: candidate.userId,
              message: `The durable account-deletion authority changed ${changedDuring}`,
              operation: "recheckDeletionAuthority",
            }),
        ),
        Effect.asVoid,
      );
    if (candidate.agentId !== null) {
      yield* requireCurrentAuthority("before provider quiescence");
      yield* dependencies.agents.quiesce(candidate.agentId, candidate.userId);
    }
    yield* requireCurrentAuthority("before provider knowledge deletion");
    yield* provider.deleteUserKnowledge({ userId: candidate.userId }).pipe(
      Effect.mapError(
        (cause) =>
          new AccountDeletionUnavailable({
            cause,
            message: "Provider knowledge deletion remains pending",
            operation: "deleteProviderKnowledge",
          }),
      ),
    );
    yield* requireCurrentAuthority("before object deletion");
    yield* dependencies.objects.remove(candidate.userId);
    if (candidate.agentId !== null) {
      yield* requireCurrentAuthority("before Agent deletion");
      yield* dependencies.agents.remove(candidate.agentId);
    }
    yield* requireCurrentAuthority("before PostgreSQL deletion");
    yield* dependencies.persistence.removeUser(candidate.userId);
    return undefined;
  });

  const reconcilePending = dependencies.persistence.pending.pipe(
    Effect.flatMap((pending) =>
      Effect.forEach(
        pending,
        (candidate) =>
          reconcileOne(candidate).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Account deletion remains pending").pipe(
                Effect.annotateLogs({ cause, userId: candidate.userId }),
              ),
            ),
          ),
        { concurrency: 1, discard: true },
      ),
    ),
  );

  const reconcileUser = Effect.fn("AccountDeletion.reconcileUser")(function* (userId: UserId) {
    const pending = yield* dependencies.persistence.pending;
    const candidate = pending.find((item) => item.userId === userId);
    if (candidate !== undefined) yield* reconcileOne(candidate);
    return undefined;
  });

  return Service.of({ reconcileOne, reconcilePending, reconcileUser });
});

/** Account-deletion Layer that preserves provider and runtime-port requirements. */
export const layerWithoutDependencies = Layer.effect(Service, make);

export * as AccountDeletion from "./account-deletion";
