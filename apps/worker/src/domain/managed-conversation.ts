import { Schema } from "effect";

import { AllowancePeriodId, Plan, PlanPolicyVersion, ThinkSubmissionId } from "../domain";
import { ManagedModelRoute } from "./model-access-policy";

const boundedIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const positiveInteger = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** Trusted cancellation of one Think-owned managed conversation Submission. */
export const CancelManagedConversationInput = Schema.Struct({
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  submissionId: ThinkSubmissionId,
});

/** RPC representation of one managed conversation cancellation. */
export type CancelManagedConversationEncoded = typeof CancelManagedConversationInput.Encoded;

/** JSON-safe policy facts pinned to an existing Think Submission. */
export const ManagedTurnMetadata = Schema.TaggedStruct("OsfoManagedTurn", {
  allowancePeriodId: AllowancePeriodId,
  conservativeVendorUsdMicros: positiveInteger,
  maxContextBytes: positiveInteger,
  maxOutputTokens: positiveInteger,
  maxRetries: Schema.Literal(0),
  maxSteps: positiveInteger,
  plan: Plan,
  planPolicyVersion: PlanPolicyVersion,
  route: ManagedModelRoute,
  submissionId: boundedIdentity,
  targetInputTokens: positiveInteger,
});

/** JSON-safe policy facts pinned to an existing Think Submission. */
export type ManagedTurnMetadata = typeof ManagedTurnMetadata.Type;

/** Keep the newest JSON-safe Think messages within one route's conservative byte budget. */
export const boundManagedContext = <A>(
  messages: ReadonlyArray<A>,
  system: string,
  maximumInputBytes: number,
): Array<A> => {
  let availableBytes = Math.max(
    0,
    maximumInputBytes - new TextEncoder().encode(encodeJson(system)).byteLength,
  );
  const retained: Array<A> = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const messageBytes = new TextEncoder().encode(encodeJson(message)).byteLength;
    if (messageBytes > availableBytes) break;
    retained.unshift(message);
    availableBytes -= messageBytes;
  }
  return retained;
};
