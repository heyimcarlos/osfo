import { Schema } from "effect";

import { AllowancePeriodId, Plan, PlanPolicyVersion, ThinkSubmissionId } from "../domain";
import { ManagedModelRoute } from "./model-access-policy";
import { OriginatingAuthority } from "./authority";

const positiveInteger = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));

/** Trusted cancellation of one Think-owned managed conversation Submission. */
export const CancelManagedConversationInput = Schema.Struct({
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  submissionId: ThinkSubmissionId,
});

/** JSON-safe policy facts pinned to an existing Think Submission. */
export const ManagedTurnMetadata = Schema.TaggedStruct("OsfoManagedTurn", {
  allowancePeriodId: AllowancePeriodId,
  conservativeVendorUsdMicros: positiveInteger,
  maxInputTokens: positiveInteger,
  maxOutputTokens: positiveInteger,
  maxRetries: Schema.Literal(0),
  maxSteps: positiveInteger,
  originatingAuthority: OriginatingAuthority,
  plan: Plan,
  planPolicyVersion: PlanPolicyVersion,
  route: ManagedModelRoute,
  submissionId: ThinkSubmissionId,
  targetInputTokens: positiveInteger,
});

/** JSON-safe policy facts pinned to an existing Think Submission. */
export type ManagedTurnMetadata = typeof ManagedTurnMetadata.Type;
