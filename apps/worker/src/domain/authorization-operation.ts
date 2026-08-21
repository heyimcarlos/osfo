import { Schema } from "effect";

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

/** Stable closed names for all launch authorization operations. */
export const AuthorizationOperationName = Schema.Literals([
  ...simpleOperations,
  "conversation.run",
  "file.upload",
  "document.generate",
  "reminder.manage",
  "reminder.deliver",
  "workflow.manage",
  "gmail.connection.manage",
]);

/** Stable closed names for all launch authorization operations. */
export type AuthorizationOperationName = typeof AuthorizationOperationName.Type;

/** Closed, schema-checked union of launch authorization operations. */
export const AuthorizationOperation = Schema.Union([
  ...simpleOperations.map(simpleOperation),
  Schema.Struct({
    actionId: Schema.String,
    kind: Schema.Literal("conversation.run"),
    modelSteps: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  }),
  Schema.Struct({
    actionId: Schema.String,
    bytes: Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)),
    kind: Schema.Literal("file.upload"),
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
      "recurringMaterialChange",
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
]);

/** Closed, schema-checked union of launch authorization operations. */
export type AuthorizationOperation = typeof AuthorizationOperation.Type;

/** Flat operation input parsed by the Authorization boundary. */
export type AuthorizationOperationInput = Readonly<Record<string, bigint | string>>;
