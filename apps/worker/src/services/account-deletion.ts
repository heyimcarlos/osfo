import { Context, DateTime, Effect, Layer, Predicate, Schema } from "effect";

import { type AgentId, type PlanPolicyVersion, UserId } from "../domain";
import type { AdminActorId, AdminReason } from "../domain/account-administration";
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

/* oxlint-disable eslint/no-underscore-dangle -- Domain variants use the canonical _tag discriminator. */

interface PendingAccountDeletionBase {
  readonly agentId: AgentId | null;
  readonly deletionCaseId: DeletionCaseId;
  readonly userId: UserId;
}

/** One self-service Deletion Case carrying the exact accepted Approval. */
export interface PendingSelfAccountDeletion extends PendingAccountDeletionBase {
  readonly _tag: "SelfService";
  readonly approvalActionId: ActionId;
  readonly approvalPresentation: ApprovalPresentation;
}

/** One administrator-started Deletion Case carrying its immutable manual authority. */
export interface PendingAdministrativeAccountDeletion extends PendingAccountDeletionBase {
  readonly _tag: "Administrative";
  readonly adminActorId: AdminActorId;
  readonly reason: AdminReason;
}

/** One fenced account still carrying a durable deletion obligation. */
export type PendingAccountDeletion =
  | PendingAdministrativeAccountDeletion
  | PendingSelfAccountDeletion;

/** One current provider-owned integration authority targeted to the deleting User. */
export const IntegrationAuthorityTargetId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
).pipe(Schema.brand("IntegrationAuthorityTargetId"));

/** One current provider-owned integration authority targeted to the deleting User. */
export type IntegrationAuthorityTargetId = typeof IntegrationAuthorityTargetId.Type;

/** One current provider-owned integration authority targeted to the deleting User. */
export interface IntegrationAuthorityTarget {
  readonly connectionId: IntegrationAuthorityTargetId;
  readonly userId: UserId;
}

/** One case-owned integration target retained before provider contact. */
export const IntegrationAuthorityTargetProgress = Schema.Struct({
  connectionId: IntegrationAuthorityTargetId,
  status: Schema.Literals(["confirmed", "pending"]),
  userId: UserId,
});

/** Case-owned integration targets retained across retries and process loss. */
export const IntegrationAuthorityTargetProgresses = Schema.Array(
  IntegrationAuthorityTargetProgress,
);
export type IntegrationAuthorityTargetProgress = typeof IntegrationAuthorityTargetProgress.Type;

/** Current mutable facts retained outside the durable Deletion Case authority. */
export interface CurrentAuthorizationFacts {
  readonly administrativeAuthority: { readonly adminActorId: AdminActorId } | null;
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
    /** Fence ordinary Agent/R2 work and drain provider activity before object deletion. */
    readonly quiesce: (
      agentId: AgentId,
      userId: UserId,
    ) => Effect.Effect<void, AccountDeletionUnavailable>;
    readonly remove: (agentId: AgentId) => Effect.Effect<void, AccountDeletionUnavailable>;
  };
  readonly integrations: {
    /** Discover only connection authorities that still exist for this User. */
    readonly pending: (
      userId: UserId,
    ) => Effect.Effect<ReadonlyArray<IntegrationAuthorityTarget>, AccountDeletionUnavailable>;
    /** Return only after this exact provider connection is confirmed absent. */
    readonly revoke: (
      target: IntegrationAuthorityTarget,
    ) => Effect.Effect<void, AccountDeletionUnavailable>;
  };
  readonly objects: {
    readonly remove: (
      userId: UserId,
      authorizeDelete: Effect.Effect<void, AccountDeletionUnavailable>,
    ) => Effect.Effect<void, AccountDeletionUnavailable>;
  };
  readonly persistence: {
    readonly pending: Effect.Effect<
      ReadonlyArray<PendingAccountDeletion>,
      AccountDeletionUnavailable
    >;
    /** Retain newly discovered targets and return every target still requiring confirmation. */
    readonly stageIntegrationTargets: (
      candidate: PendingAccountDeletion,
      discovered: ReadonlyArray<IntegrationAuthorityTarget>,
    ) => Effect.Effect<ReadonlyArray<IntegrationAuthorityTarget>, AccountDeletionUnavailable>;
    /** Mark one exact target confirmed only after the provider proves it absent. */
    readonly confirmIntegrationTarget: (
      candidate: PendingAccountDeletion,
      target: IntegrationAuthorityTarget,
    ) => Effect.Effect<void, AccountDeletionUnavailable>;
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
    if (candidate._tag === "Administrative") {
      return (
        facts.administrativeAuthority?.adminActorId === candidate.adminActorId &&
        facts.resourceOwnerUserId === candidate.userId
      );
    }
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
    const discoveredIntegrationTargets = yield* dependencies.integrations.pending(candidate.userId);
    for (const target of discoveredIntegrationTargets) {
      if (target.userId !== candidate.userId) {
        return yield* new AccountDeletionUnavailable({
          cause: target,
          message: "Integration authority discovery crossed the deleting User fence",
          operation: "deleteIntegrationAuthority",
        });
      }
    }
    const integrationTargets = yield* dependencies.persistence.stageIntegrationTargets(
      candidate,
      discoveredIntegrationTargets,
    );
    for (const target of integrationTargets) {
      if (target.userId !== candidate.userId) {
        return yield* new AccountDeletionUnavailable({
          cause: target,
          message: "Retained integration authority crossed the deleting User fence",
          operation: "deleteIntegrationAuthority",
        });
      }
      yield* requireCurrentAuthority("before an integration authority deletion");
      yield* dependencies.integrations.revoke(target);
      yield* dependencies.persistence.confirmIntegrationTarget(candidate, target);
    }
    yield* dependencies.objects.remove(
      candidate.userId,
      requireCurrentAuthority("before an R2 object deletion"),
    );
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
