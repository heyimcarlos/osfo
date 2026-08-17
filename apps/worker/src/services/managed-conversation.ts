import { Effect, Predicate, Schema } from "effect";

import { ThinkSubmissionId } from "../domain";
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
  make as makeAuthorization,
} from "./authorization";

const boundedIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const boundedMessage = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000));

/** Trusted facts required to authorize one server-managed Think Submission. */
export const SubmitManagedConversationInput = Schema.Struct({
  authorization: AuthorizationContext,
  idempotencyKey: boundedIdentity,
  message: boundedMessage,
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

/** Admit one conversation with a server-owned route and its worst-case request cost. */
export const admitManagedConversation = (
  input: SubmitManagedConversation,
): Effect.Effect<
  ManagedConversationAdmitted | ManagedConversationDenied,
  ManagedRouteUnavailable | PlanPolicyNotFound
> =>
  Effect.gen(function* () {
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
      return {
        _tag: "ManagedConversationDenied",
        reason: Predicate.isTagged(admission, "Denied") ? admission.reason : "approvalRequired",
        resetAt: Predicate.isTagged(admission, "Denied") ? admission.resetAt : null,
      } as const;
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
        conservativeVendorUsdMicros: Number(maxVendorUsdMicros),
        maxInputTokens: profile.context.maxInputTokens,
        maxOutputTokens: profile.context.maxOutputTokens,
        maxRetries: profile.maxRetries,
        maxSteps,
        plan,
        planPolicyVersion,
        route: profile.route,
        submissionId: input.submissionId,
        targetInputTokens: profile.context.targetInputTokens,
      }),
      submissionId: input.submissionId,
    } as const;
  });
