import { Schema } from "effect";

const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/** Server-owned root identity propagated through a production qualification journey. */
export const QualificationContext = Schema.Struct({
  attemptId: identity,
  executionId: identity,
  journey: Schema.Literals([
    "accountBillingSafetyDataRights",
    "documentBuild",
    "fileAnalysis",
    "gmail",
    "ordinaryConversation",
    "registration",
    "reminder",
    "researchReport",
    "scheduledEmail",
  ]),
  offeredAtEpochMs: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  planChecksum: identity,
  region: Schema.Literals(["americas", "asiaPacific", "europe"]),
  rootId: identity,
  runId: identity,
});

/** Server-owned root identity propagated through a production qualification journey. */
export type QualificationContext = typeof QualificationContext.Type;

/** Compare the complete server-owned qualification identity without partial-field drift. */
export const sameQualificationContext = (
  left: QualificationContext | undefined,
  right: QualificationContext | undefined,
): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.attemptId === right.attemptId &&
  left.executionId === right.executionId &&
  left.journey === right.journey &&
  left.offeredAtEpochMs === right.offeredAtEpochMs &&
  left.planChecksum === right.planChecksum &&
  left.region === right.region &&
  left.rootId === right.rootId &&
  left.runId === right.runId;
