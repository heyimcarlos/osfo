import { Effect, Predicate, Schema } from "effect";

import { ConversationRouteId, ThinkSubmissionId, type SessionId } from "../domain";
import {
  isLaunchPolicy,
  policyFor,
  policyForVersion,
  retainedCatalog,
  type PlanPolicyNotFound,
} from "../domain/plan-policy";
import { currentCapabilityCatalog } from "../domain/capability-catalog";
import {
  launchModelAccessPolicy,
  ManagedRouteUnavailable,
  selectManagedRoute,
} from "../domain/model-access-policy";
import { ManagedTurnAuthorityIdentity, ManagedTurnMetadata } from "../domain/managed-conversation";
import {
  AuthorizationContext,
  AuthorizationDenialReason,
  type AuthorizationResult,
  Authorization,
  snapshotCoreMemoryAuthorization,
} from "./authorization";
import { CoreMemoryAuthorizationSnapshot } from "../domain/core-memory-authorization";
import { isDeletionOrDataRightsIntent } from "./capability-intent-policy";

/* oxlint-disable eslint/no-underscore-dangle -- Authority identities use the _tag discriminator. */

const boundedIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const boundedMessage = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000));

/** Trusted facts required to authorize one server-managed Think Submission. */
export const SubmitManagedConversationInput = Schema.Struct({
  authorization: AuthorizationContext,
  idempotencyKey: boundedIdentity,
  message: boundedMessage,
  routeId: ConversationRouteId,
  submissionId: ThinkSubmissionId,
});

/** Trusted managed-conversation input after the RPC boundary validates authorization separately. */
export type SubmitManagedConversation = typeof SubmitManagedConversationInput.Type;

/** Successful managed-conversation admission ready for Think submission. */
export interface ManagedConversationAdmitted {
  readonly _tag: "ManagedConversationAdmitted";
  readonly idempotencyKey: string;
  readonly message: string;
  readonly metadata: ManagedTurnMetadata;
  readonly submissionId: ThinkSubmissionId;
}

/** Closed denial returned before a managed Think Submission is created. */
export const ManagedConversationDenied = Schema.TaggedStruct("ManagedConversationDenied", {
  reason: AuthorizationDenialReason,
  resetAt: Schema.NullOr(Schema.Date),
});

/** Closed denial returned before a managed Think Submission is created. */
export type ManagedConversationDenied = typeof ManagedConversationDenied.Type;

/** Authorized transport-neutral request to replace one route current Session. */
export interface ManagedSessionReplacementAdmitted {
  readonly _tag: "ManagedSessionReplacementAdmitted";
  readonly routeId: ConversationRouteId;
  readonly submissionId: ThinkSubmissionId;
}

/** Canonical Agent-owned Session facts used at the serialized admission boundary. */
export interface ManagedConversationSessionFacts {
  readonly currentSessionId: SessionId;
  readonly routeId: ConversationRouteId;
}

/** Admit one conversation with a server-owned route and its worst-case request cost. */
export const admitManagedConversation = (
  input: SubmitManagedConversation,
  session: ManagedConversationSessionFacts,
): Effect.Effect<
  ManagedConversationAdmitted | ManagedConversationDenied | ManagedSessionReplacementAdmitted,
  ManagedRouteUnavailable | PlanPolicyNotFound
> =>
  Effect.gen(function* () {
    if (input.routeId !== session.routeId) {
      return {
        _tag: "ManagedConversationDenied",
        reason: "authorityMismatch",
        resetAt: null,
      } as const;
    }
    if (input.message.trim() === "/new") {
      const admission = Authorization.make(retainedCatalog).admit(input.authorization, {
        actionId: input.submissionId,
        kind: "session.replace",
      });
      if (!Predicate.isTagged(admission, "Admitted")) return denied(admission);
      return {
        _tag: "ManagedSessionReplacementAdmitted",
        routeId: session.routeId,
        submissionId: input.submissionId,
      } as const;
    }
    const plan = input.authorization.subscription.plan;
    const planPolicyVersion = input.authorization.subscription.planPolicyVersion;
    const profile = yield* selectManagedRoute(launchModelAccessPolicy, plan, planPolicyVersion);
    const planPolicy = yield* policyForVersion(retainedCatalog, planPolicyVersion);
    if (!isLaunchPolicy(planPolicy)) {
      return yield* new ManagedRouteUnavailable({
        message: "Shared Plan Usage routing is not activated",
        plan,
        planPolicyVersion,
      });
    }
    const operationLimits = policyFor(planPolicy, plan).operationLimits;
    const maxVendorUsdMicros = operationLimits.vendorUsdMicrosPerRequest;
    const authorization = Authorization.make(retainedCatalog);
    const authorizationContext = {
      ...input.authorization,
      requestVendorUsdMicros: maxVendorUsdMicros,
    };
    const ordinaryAdmission = authorization.admit(authorizationContext, {
      actionId: input.submissionId,
      kind: "conversation.run",
      modelSteps: operationLimits.modelStepsPerRequest,
    });
    const exhaustedLimits = currentCapabilityCatalog.exhaustedConversation;
    const admission =
      Predicate.isTagged(ordinaryAdmission, "Denied") &&
      ordinaryAdmission.reason === "allowanceExhausted" &&
      isDeletionOrDataRightsIntent(input.message)
        ? authorization.admit(authorizationContext, {
            actionId: input.submissionId,
            documentChunks: 0n,
            exhaustedContinuity: "deletionOrDataRights",
            inputTokens: BigInt(exhaustedLimits.inputTokens),
            kind: "conversation.run",
            memoryDeadlineMilliseconds: BigInt(exhaustedLimits.memoryDeadlineMilliseconds),
            memoryProfileTokens: BigInt(exhaustedLimits.memoryProfileTokens),
            memoryQueryTokens: BigInt(exhaustedLimits.memoryQueryTokens),
            memoryRecalls: BigInt(exhaustedLimits.memoryRecalls),
            modelSteps: BigInt(exhaustedLimits.modelSteps),
            outputTokens: BigInt(exhaustedLimits.outputTokens),
            queryRewrites: 0n,
            rerankingPasses: 0n,
            retries: BigInt(exhaustedLimits.retries),
            skillInstructions: exhaustedLimits.skillInstructions,
            skillLearningJobs: 0n,
            toolExecutions: 0n,
          })
        : ordinaryAdmission;
    if (!Predicate.isTagged(admission, "Admitted")) {
      return denied(admission);
    }
    if (!Predicate.isTagged(input.authorization.allowance, "Metered")) {
      return {
        _tag: "ManagedConversationDenied",
        reason: "allowancePeriodUnavailable",
        resetAt: null,
      } as const;
    }
    const exhausted = admission.executionMode === "exhaustedConversation";
    const maxInputTokens = exhausted ? exhaustedLimits.inputTokens : profile.context.maxInputTokens;
    const maxOutputTokens = exhausted
      ? exhaustedLimits.outputTokens
      : profile.context.maxOutputTokens;
    const maxSteps = exhausted
      ? exhaustedLimits.modelSteps
      : Number(operationLimits.modelStepsPerRequest);
    const targetInputTokens = exhausted
      ? Math.min(profile.context.targetInputTokens, exhaustedLimits.inputTokens - 1)
      : profile.context.targetInputTokens;
    const coreMemoryAuthorization = yield* Schema.encodeEffect(CoreMemoryAuthorizationSnapshot)(
      snapshotCoreMemoryAuthorization(input.authorization),
    ).pipe(Effect.orDie);
    const origin = input.authorization.originatingAuthority;
    if (origin._tag === "DurableTrigger" && origin.triggerType === "deletionCase") {
      return yield* Effect.die(
        new Error("A Deletion Case authority cannot originate a managed conversation"),
      );
    }
    const managedOrigin =
      origin._tag === "DurableTrigger"
        ? {
            ...origin,
            triggerType:
              origin.triggerType === "scheduledTask"
                ? ("scheduledTask" as const)
                : ("workflow" as const),
          }
        : origin;
    const authorityIdentity =
      managedOrigin._tag !== "ChannelLink"
        ? ManagedTurnAuthorityIdentity.make({
            ...managedOrigin,
            userId: input.authorization.user.userId,
          })
        : Predicate.isTagged(input.authorization.authority, "ChannelLink")
          ? ManagedTurnAuthorityIdentity.make({
              ...managedOrigin,
              address: input.authorization.authority.address,
              userId: input.authorization.user.userId,
            })
          : yield* Effect.die(
              new Error("A Channel Link turn was admitted without current Channel Link authority"),
            );
    return {
      _tag: "ManagedConversationAdmitted",
      idempotencyKey: input.idempotencyKey,
      message: input.message,
      metadata: ManagedTurnMetadata.make({
        _tag: "OsfoManagedTurn",
        allowancePeriodId: input.authorization.allowance.allowancePeriodId,
        authorityIdentity,
        capabilityCatalogVersion: currentCapabilityCatalog.version,
        capabilityTurnState: {
          eligiblePersonalSkills: [],
          initialized: false,
          loadedSkillReceipts: [],
          pendingFileAnalyses: [],
          skillLearningDraft: null,
        },
        conservativeVendorUsdMicros: Number(maxVendorUsdMicros),
        coreMemoryAuthorization,
        executionMode: exhausted ? "exhaustedConversation" : "normalPlanUsage",
        maxInputTokens,
        maxOutputTokens,
        maxRetries: profile.maxRetries,
        maxSteps,
        originatingAuthority: input.authorization.originatingAuthority,
        plan,
        planPolicyVersion,
        routeId: session.routeId,
        route: profile.route,
        sessionId: session.currentSessionId,
        submissionId: input.submissionId,
        targetInputTokens,
      }),
      submissionId: input.submissionId,
    } as const;
  });

const denied = (
  admission: Exclude<AuthorizationResult, { readonly _tag: "Admitted" }>,
): ManagedConversationDenied => ({
  _tag: "ManagedConversationDenied",
  reason: Predicate.isTagged(admission, "Denied") ? admission.reason : "approvalRequired",
  resetAt: Predicate.isTagged(admission, "Denied") ? admission.resetAt : null,
});
