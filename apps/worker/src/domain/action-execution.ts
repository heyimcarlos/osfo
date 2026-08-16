import { Schema } from "effect";

import { ActionId } from "./action-approval";

const evidenceText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000));

/** Provider evidence after one committed Action executor contacts an external system. */
export const ActionExecutionResult = Schema.Union([
  Schema.TaggedStruct("Applied", {
    actionId: ActionId,
    evidence: evidenceText,
    providerOperationId: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("NotApplied", {
    actionId: ActionId,
    evidence: evidenceText,
  }),
  Schema.TaggedStruct("Ambiguous", {
    actionId: ActionId,
    evidence: evidenceText,
    retry: Schema.Literal("reconcile-before-retry"),
  }),
]);

/** Provider evidence after one committed Action executor contacts an external system. */
export type ActionExecutionResult = typeof ActionExecutionResult.Type;

/** Normalize an unknown provider outcome without treating ambiguity as no effect. */
export const ambiguousActionResult = (
  actionId: ActionId,
  evidence: string,
): ActionExecutionResult =>
  ActionExecutionResult.make({
    _tag: "Ambiguous",
    actionId,
    evidence,
    retry: "reconcile-before-retry",
  });
