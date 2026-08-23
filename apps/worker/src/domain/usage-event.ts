import { Result, Schema } from "effect";

import {
  AllowancePeriodId,
  CapabilityCatalogVersion,
  ManifestVersion,
  ModelAccessPolicyVersion,
  PlanPolicyVersion,
} from "../domain";
import { AllowanceSource } from "./allowance";
import { UsageCharge } from "./usage";

/* oxlint-disable eslint/no-underscore-dangle -- Usage Event outcomes use the standard Effect _tag discriminator. */

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

/** Opaque external evidence reference safe to retain without provider content. */
export const UsageEvidenceReference = Schema.Struct({
  kind: Schema.Literals(["providerLog", "gatewayLog", "companyCost", "operationEvidence"]),
  reference: nonEmptyString,
});

/** Opaque external evidence reference safe to retain without provider content. */
export type UsageEvidenceReference = typeof UsageEvidenceReference.Type;

/** Final useful or uncharged outcome for one Usage Event. */
export const UsageEventOutcome = Schema.Union([
  Schema.TaggedStruct("Completed", { charge: UsageCharge }),
  Schema.TaggedStruct("UsefulPartial", { charge: UsageCharge }),
  Schema.TaggedStruct("Failed", {}),
  Schema.TaggedStruct("Cancelled", {}),
]);

/** Final useful or uncharged outcome for one Usage Event. */
export type UsageEventOutcome = typeof UsageEventOutcome.Type;

/** One completed operation or Workflow occurrence keyed by its existing source identity. */
export const UsageEvent = Schema.Struct({
  allowancePeriodId: AllowancePeriodId,
  capabilityCatalogVersion: CapabilityCatalogVersion,
  evidenceReferences: Schema.Array(UsageEvidenceReference),
  manifestVersion: Schema.NullOr(ManifestVersion),
  modelAccessPolicyVersion: ModelAccessPolicyVersion,
  occurredAt: Schema.Date,
  outcome: UsageEventOutcome,
  rootOperationId: nonEmptyString,
  source: AllowanceSource,
  usagePolicyVersion: PlanPolicyVersion,
}).check(
  Schema.makeFilter(
    (event) =>
      (event.outcome._tag !== "Completed" && event.outcome._tag !== "UsefulPartial") ||
      event.outcome.charge.usagePolicyVersion === event.usagePolicyVersion ||
      "Usage Event and charge must name the same Usage Policy Version",
  ),
  Schema.makeFilter(
    (event) =>
      new Set(event.evidenceReferences.map(({ kind, reference }) => `${kind}\u0000${reference}`))
        .size === event.evidenceReferences.length ||
      "Usage Event evidence references must be unique",
  ),
);

/** One completed operation or Workflow occurrence keyed by its existing source identity. */
export type UsageEvent = typeof UsageEvent.Type;

/** Invalid or secret-bearing evidence refused before persistence. */
export class UsageEventInvalid extends Schema.TaggedError<UsageEventInvalid>()(
  "UsageEventInvalid",
  {
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

/** Same operation identity retried with different immutable Usage Event facts. */
export class UsageEventConflict extends Schema.TaggedError<UsageEventConflict>()(
  "UsageEventConflict",
  {
    allowancePeriodId: AllowancePeriodId,
    message: Schema.String,
    sourceId: Schema.String,
    sourceType: Schema.String,
  },
) {}

/** Parse unknown completed evidence strictly before it reaches the ledger. */
// oxlint-disable-next-line osfo/no-unknown-parameters -- This function is the schema parser at the Usage Event boundary.
export const parseUsageEvent = (input: unknown): Result.Result<UsageEvent, UsageEventInvalid> =>
  Result.mapError(
    Schema.decodeUnknownResult(UsageEvent)(input, { onExcessProperty: "error" }),
    (cause) =>
      new UsageEventInvalid({
        cause,
        message: "The Usage Event evidence is invalid",
      }),
  );
