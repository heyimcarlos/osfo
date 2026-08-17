import { Effect, Predicate, Schema } from "effect";

import { ConversationRouteId, ThinkSubmissionId, type SessionId } from "../domain";
import {
  policyFor,
  policyForVersion,
  retainedCatalog,
  type PlanPolicyNotFound,
} from "../domain/plan-policy";
import {
  launchModelAccessPolicy,
  type ManagedRouteUnavailable,
  selectManagedRoute,
} from "../domain/model-access-policy";
import { ManagedTurnMetadata } from "../domain/managed-conversation";
import {
  AuthorizationContext,
  AuthorizationDenialReason,
  type AuthorizationResult,
  make as makeAuthorization,
} from "./authorization";

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
      const admission = makeAuthorization(retainedCatalog).admit(input.authorization, {
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
    const operationLimits = policyFor(planPolicy, plan).operationLimits;
    const maxSteps = Number(operationLimits.modelStepsPerRequest);
    const maxVendorUsdMicros = operationLimits.vendorUsdMicrosPerRequest;
    const admission = makeAuthorization(retainedCatalog).admit(
      { ...input.authorization, requestVendorUsdMicros: maxVendorUsdMicros },
      {
        actionId: input.submissionId,
        kind: "conversation.run",
        modelSteps: operationLimits.modelStepsPerRequest,
      },
    );
    if (!Predicate.isTagged(admission, "Admitted")) {
      return denied(admission);
    }
    if (!Predicate.isTagged(admission.allowancePeriod, "Metered")) {
      return {
        _tag: "ManagedConversationDenied",
        reason: "allowancePeriodUnavailable",
        resetAt: null,
      } as const;
    }
    return {
      _tag: "ManagedConversationAdmitted",
      idempotencyKey: input.idempotencyKey,
      message: input.message,
      metadata: ManagedTurnMetadata.make({
        _tag: "OsfoManagedTurn",
        allowancePeriodId: admission.allowancePeriod.allowancePeriodId,
        authorityIdentity: {
          ...input.authorization.originatingAuthority,
          userId: input.authorization.user.userId,
        },
        conservativeVendorUsdMicros: Number(maxVendorUsdMicros),
        maxInputTokens: profile.context.maxInputTokens,
        maxOutputTokens: profile.context.maxOutputTokens,
        maxRetries: profile.maxRetries,
        maxSteps,
        originatingAuthority: input.authorization.originatingAuthority,
        plan,
        planPolicyVersion,
        routeId: session.routeId,
        route: profile.route,
        sessionId: session.currentSessionId,
        submissionId: input.submissionId,
        targetInputTokens: profile.context.targetInputTokens,
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
