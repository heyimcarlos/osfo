import { Schema } from "effect";

import { ManifestVersion } from "../domain";
import { ArtifactKind, SkillChange } from "./capability-catalog";

const nonNegative = Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n));
const positive = Schema.BigInt.check(Schema.isGreaterThanBigInt(0n));
const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

const simpleOperation = <const Kind extends string>(kind: Kind) =>
  Schema.Struct({ actionId: Schema.String, kind: Schema.Literal(kind) });

const simpleOperations = [
  "conversation.accept",
  "session.recall",
  "session.replace",
  "session.delete",
  "memory.inspect",
  "memory.correct",
  "memory.clear",
  "memory.forgetKnowledge",
  "file.read",
  "file.analyze",
  "file.delete",
  "workflow.inspect",
  "workflow.cancel",
  "gmail.search",
  "gmail.read",
  "gmail.draft",
  "gmail.send",
  "support.open",
  "support.gmSummon",
  "usage.inspect",
  "billing.inspect",
  "subscription.manage",
  "authSession.revoke",
  "channelLink.revoke",
  "phoneAccount.replace",
  "account.delete",
  "dataRights.request",
] as const;

const governedSimpleOperations = ["skill.inspect", "artifact.read", "artifact.delete"] as const;

/** Stable closed names for all launch authorization operations. */
export const AuthorizationOperationName = Schema.Literals([
  ...simpleOperations,
  ...governedSimpleOperations,
  "conversation.run",
  "file.upload",
  "document.generate",
  "reminder.manage",
  "reminder.deliver",
  "workflow.manage",
  "gmail.connection.manage",
  "skill.manage",
  "artifact.generate",
  "artifact.revise",
  "integration.connection.manage",
  "integration.read",
  "integration.effect",
  "web.search",
  "web.read",
]);

/** Stable closed names for all launch authorization operations. */
export type AuthorizationOperationName = typeof AuthorizationOperationName.Type;

/** Closed, schema-checked union of launch authorization operations. */
export const AuthorizationOperation = Schema.Union([
  ...simpleOperations.map(simpleOperation),
  ...governedSimpleOperations.map(simpleOperation),
  Schema.Struct({
    actionId: Schema.String,
    documentChunks: Schema.optionalKey(nonNegative),
    exhaustedContinuity: Schema.optionalKey(Schema.Literal("deletionOrDataRights")),
    kind: Schema.Literal("conversation.run"),
    inputTokens: Schema.optionalKey(nonNegative),
    memoryDeadlineMilliseconds: Schema.optionalKey(nonNegative),
    memoryProfileTokens: Schema.optionalKey(nonNegative),
    memoryQueryTokens: Schema.optionalKey(nonNegative),
    memoryRecalls: Schema.optionalKey(nonNegative),
    modelSteps: nonNegative,
    outputTokens: Schema.optionalKey(nonNegative),
    queryRewrites: Schema.optionalKey(nonNegative),
    rerankingPasses: Schema.optionalKey(nonNegative),
    retries: Schema.optionalKey(nonNegative),
    skillInstructions: Schema.optionalKey(
      Schema.Literals(["locallyAvailableOnly", "providerBacked"]),
    ),
    skillLearningJobs: Schema.optionalKey(nonNegative),
    toolExecutions: Schema.optionalKey(nonNegative),
  }),
  Schema.Struct({
    actionId: Schema.String,
    bytes: Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)),
    kind: Schema.Literal("file.upload"),
  }),
  Schema.Struct({
    actionId: Schema.String,
    artifactKind: ArtifactKind,
    bytes: positive,
    computeMilliseconds: positive,
    kind: Schema.Literals(["artifact.generate", "artifact.revise"]),
    modelSteps: nonNegative,
    pages: nonNegative,
    pixelsPerEdge: nonNegative,
    slides: nonNegative,
  }),
  Schema.Struct({
    actionId: Schema.String,
    change: SkillChange,
    kind: Schema.Literal("skill.manage"),
  }),
  Schema.Struct({
    actionId: Schema.String,
    artifactKind: Schema.Literals(["document", "researchReport"]),
    bytes: Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)),
    kind: Schema.Literal("document.generate"),
    pages: Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)),
    researchSearches: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  }),
  Schema.Struct({
    actionId: Schema.String,
    change: Schema.Literals([
      "oneTimeCreate",
      "recurringCreate",
      "oneTimeMaterialChange",
      "recurringMaterialChange",
      "oneTimeReactivate",
      "recurringReactivate",
      "cancel",
    ]),
    kind: Schema.Literal("reminder.manage"),
  }),
  Schema.Struct({
    actionId: Schema.String,
    kind: Schema.Literal("reminder.deliver"),
    schedule: Schema.Literals(["oneTime", "recurring"]),
  }),
  Schema.Struct({
    actionId: Schema.String,
    change: Schema.Literals(["start", "materialChange", "stop"]),
    kind: Schema.Literal("workflow.manage"),
  }),
  Schema.Struct({
    actionId: Schema.String,
    change: Schema.Literals(["connect", "revoke"]),
    kind: Schema.Literal("gmail.connection.manage"),
  }),
  Schema.Struct({
    actionId: Schema.String,
    change: Schema.Literals(["connect", "revoke"]),
    kind: Schema.Literal("integration.connection.manage"),
    toolkit: nonEmptyString,
  }),
  Schema.Struct({
    actionId: Schema.String,
    attachments: nonNegative,
    deadlineMilliseconds: positive,
    kind: Schema.Literal("integration.read"),
    manifestVersion: ManifestVersion,
    pagination: nonNegative,
    providerExecutions: positive,
    providerOperation: nonEmptyString,
    records: positive,
    responseBytes: positive,
    toolkit: nonEmptyString,
    windowDays: Schema.optionalKey(nonNegative),
  }),
  Schema.Struct({
    actionId: Schema.String,
    kind: Schema.Literal("integration.effect"),
    manifestVersion: ManifestVersion,
    providerOperation: nonEmptyString,
    toolkit: nonEmptyString,
  }),
  Schema.Struct({
    actionId: Schema.String,
    deadlineMilliseconds: positive,
    kind: Schema.Literal("web.search"),
    pages: nonNegative,
    redirects: nonNegative,
    responseBytes: positive,
    results: positive,
    retries: nonNegative,
    searches: positive,
  }),
  Schema.Struct({
    actionId: Schema.String,
    deadlineMilliseconds: positive,
    kind: Schema.Literal("web.read"),
    pages: positive,
    redirects: nonNegative,
    responseBytes: positive,
    retries: nonNegative,
  }),
]);

/** Closed, schema-checked union of launch authorization operations. */
export type AuthorizationOperation = typeof AuthorizationOperation.Type;

/** Flat operation input parsed by the Authorization boundary. */
export type AuthorizationOperationInput = Readonly<Record<string, bigint | string>>;
