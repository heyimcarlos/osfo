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

/** One retained Deletion Case awaiting access fencing or destructive reconciliation. */
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
  status: Schema.Literals(["confirmed", "pending", "revoked"]),
  userId: UserId,
});

/** Case-owned integration targets retained across retries and process loss. */
export const IntegrationAuthorityTargetProgresses = Schema.Array(
  IntegrationAuthorityTargetProgress,
);
export type IntegrationAuthorityTargetProgress = typeof IntegrationAuthorityTargetProgress.Type;

/** One retained provider target that still has a provider-side deletion step to finish. */
export interface ActionableIntegrationAuthorityTarget extends IntegrationAuthorityTarget {
  readonly status: "pending" | "revoked";
}

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
    /** Return only after this exact provider connection is synchronously revoked. */
    readonly revoke: (
      target: IntegrationAuthorityTarget,
    ) => Effect.Effect<void, AccountDeletionUnavailable>;
    /** Soft-delete one durably revoked provider connection and confirm exact absence. */
    readonly remove: (
      target: IntegrationAuthorityTarget,
    ) => Effect.Effect<void, AccountDeletionUnavailable>;
  };
  readonly workflows: {
    /** Terminalize private Workflow truth and stop every execution host before object erasure. */
    readonly quiesce: (userId: UserId) => Effect.Effect<void, AccountDeletionUnavailable>;
  };
  readonly objects: {
    readonly remove: (
      userId: UserId,
      authorizeDelete: Effect.Effect<void, AccountDeletionUnavailable>,
    ) => Effect.Effect<void, AccountDeletionUnavailable>;
  };
  readonly persistence: {
    /** Confirm the exact Deletion Case has revoked every AuthSession before destructive work. */
    readonly ensureAccessFence: (
      candidate: PendingAccountDeletion,
    ) => Effect.Effect<void, AccountDeletionUnavailable>;
    readonly pending: Effect.Effect<
      ReadonlyArray<PendingAccountDeletion>,
      AccountDeletionUnavailable
    >;
    /** Retain newly discovered targets and return every target still requiring confirmation. */
    readonly stageIntegrationTargets: (
      candidate: PendingAccountDeletion,
      discovered: ReadonlyArray<IntegrationAuthorityTarget>,
    ) => Effect.Effect<
      ReadonlyArray<ActionableIntegrationAuthorityTarget>,
      AccountDeletionUnavailable
    >;
    /** Retain provider-confirmed credential revocation before soft deletion can begin. */
    readonly markIntegrationTargetRevoked: (
      candidate: PendingAccountDeletion,
      target: IntegrationAuthorityTarget,
    ) => Effect.Effect<void, AccountDeletionUnavailable>;
    /** Mark one exact target confirmed only after the provider proves it absent. */
    readonly confirmIntegrationTarget: (
      candidate: PendingAccountDeletion,
      target: IntegrationAuthorityTarget,
    ) => Effect.Effect<void, AccountDeletionUnavailable>;
    readonly removeUser: (
      candidate: PendingAccountDeletion,
    ) => Effect.Effect<void, AccountDeletionUnavailable>;
  };
}

/** Runtime boundaries owned by the account-deletion workflow. */
export class Port extends Context.Service<Port, PortInterface>()("@osfo/AccountDeletion/Port") {}

/** Caller-oriented account-deletion capability. */
export interface Interface {
  /** Fence and acknowledge the exact retained Deletion Case before an HTTP success response. */
  readonly quiesceCase: (
    userId: UserId,
    deletionCaseId: DeletionCaseId,
  ) => Effect.Effect<void, AccountDeletionUnavailable>;
  readonly reconcileOne: (
    candidate: PendingAccountDeletion,
  ) => Effect.Effect<void, AccountDeletionUnavailable>;
  // oxlint-disable-next-line effecttsgo/lazy-effect -- Scheduled reconciliation is a named service operation, not shared Effect state.
  readonly reconcilePending: () => Effect.Effect<void, AccountDeletionUnavailable>;
  readonly reconcileUser: (userId: UserId) => Effect.Effect<void, AccountDeletionUnavailable>;
}

/** Shared provider-first account-deletion service. */
// oxlint-disable-next-line effecttsgo/lazy-effect -- The service intentionally exposes named zero-argument reconciliation.
export class Service extends Context.Service<Service, Interface>()("@osfo/AccountDeletion") {}

const maximumIntegrationDeletionRounds = 10;

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

  const requireCurrentAuthority = (candidate: PendingAccountDeletion, changedDuring: string) =>
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

  const quiesceOne = Effect.fn("AccountDeletion.quiesceOne")(function* (
    candidate: PendingAccountDeletion,
  ) {
    yield* dependencies.persistence.ensureAccessFence(candidate);
    yield* requireCurrentAuthority(candidate, "before Agent quiescence acknowledgement");
    if (candidate.agentId !== null) {
      yield* dependencies.agents.quiesce(candidate.agentId, candidate.userId);
    }
    yield* dependencies.workflows.quiesce(candidate.userId);
  });

  const quiesceCase = Effect.fn("AccountDeletion.quiesceCase")(function* (
    userId: UserId,
    deletionCaseId: DeletionCaseId,
  ) {
    const pending = yield* dependencies.persistence.pending;
    const candidate = pending.find(
      (item) => item.userId === userId && item.deletionCaseId === deletionCaseId,
    );
    if (candidate === undefined) {
      return yield* new AccountDeletionUnavailable({
        cause: { deletionCaseId, userId },
        message: "The exact account-deletion case is not pending",
        operation: "quiesceAgentAccountDeletion",
      });
    }
    yield* quiesceOne(candidate);
    return undefined;
  });

  const reconcileOne = Effect.fn("AccountDeletion.reconcileOne")(function* (
    candidate: PendingAccountDeletion,
  ) {
    const requireAuthority = (changedDuring: string) =>
      requireCurrentAuthority(candidate, changedDuring);
    yield* quiesceOne(candidate);
    yield* requireAuthority("before provider knowledge deletion");
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
    yield* requireAuthority("before provider knowledge absence verification");
    const providerKnowledge = yield* provider
      .verifyUserKnowledge({ userId: candidate.userId })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AccountDeletionUnavailable({
              cause,
              message: "Provider knowledge absence verification remains pending",
              operation: "deleteProviderKnowledge",
            }),
        ),
      );
    if (providerKnowledge._tag !== "AlreadyAbsent") {
      return yield* new AccountDeletionUnavailable({
        cause: candidate.userId,
        message: "Provider knowledge deletion has not reached permanent absence",
        operation: "deleteProviderKnowledge",
      });
    }
    let integrationDeletionConverged = false;
    for (let round = 0; round < maximumIntegrationDeletionRounds; round += 1) {
      yield* requireAuthority("before integration authority discovery");
      const discovered = yield* dependencies.integrations.pending(candidate.userId);
      for (const target of discovered) {
        if (target.userId !== candidate.userId) {
          return yield* new AccountDeletionUnavailable({
            cause: target,
            message: "Integration authority discovery crossed the deleting User fence",
            operation: "deleteIntegrationAuthority",
          });
        }
      }
      yield* requireAuthority("before retaining integration authority targets");
      const actionable = yield* dependencies.persistence.stageIntegrationTargets(
        candidate,
        discovered,
      );
      if (discovered.length === 0 && actionable.length === 0) {
        integrationDeletionConverged = true;
        break;
      }
      for (const progress of actionable) {
        const target = {
          connectionId: progress.connectionId,
          userId: progress.userId,
        };
        if (target.userId !== candidate.userId) {
          return yield* new AccountDeletionUnavailable({
            cause: progress,
            message: "Retained integration authority crossed the deleting User fence",
            operation: "deleteIntegrationAuthority",
          });
        }
        if (progress.status === "pending") {
          yield* requireAuthority("before an integration authority revocation");
          yield* dependencies.integrations.revoke(target);
          yield* requireAuthority("before retaining integration authority revocation");
          yield* dependencies.persistence.markIntegrationTargetRevoked(candidate, target);
        }
        yield* requireAuthority("before a revoked integration authority removal");
        yield* dependencies.integrations.remove(target);
        yield* requireAuthority("before confirming an integration authority deletion");
        yield* dependencies.persistence.confirmIntegrationTarget(candidate, target);
      }
    }
    if (!integrationDeletionConverged) {
      return yield* new AccountDeletionUnavailable({
        cause: candidate.userId,
        message: "Integration authority deletion did not converge",
        operation: "deleteIntegrationAuthority",
      });
    }
    yield* dependencies.objects.remove(
      candidate.userId,
      requireAuthority("before an R2 object deletion"),
    );
    if (candidate.agentId !== null) {
      yield* requireAuthority("before Agent deletion");
      yield* dependencies.agents.remove(candidate.agentId);
    }
    yield* requireAuthority("before PostgreSQL deletion");
    yield* dependencies.persistence.removeUser(candidate);
    return undefined;
  });

  const reconcilePending = Effect.fn("AccountDeletion.reconcilePending")(function* () {
    const pending = yield* dependencies.persistence.pending;
    yield* Effect.forEach(
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
    );
  });

  const reconcileUser = Effect.fn("AccountDeletion.reconcileUser")(function* (userId: UserId) {
    const pending = yield* dependencies.persistence.pending;
    const candidate = pending.find((item) => item.userId === userId);
    if (candidate !== undefined) yield* reconcileOne(candidate);
    return undefined;
  });

  return Service.of({ quiesceCase, reconcileOne, reconcilePending, reconcileUser });
});

/** Account-deletion Layer that preserves provider and runtime-port requirements. */
export const layerWithoutDependencies = Layer.effect(Service, make);

export * as AccountDeletion from "./account-deletion";
