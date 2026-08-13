import { asc, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";

import {
  database,
  DbCommandId,
  DbTimestamp,
  dbCommandConflict,
  dbUnavailable,
  decodeRow,
  findCommand,
  fingerprintCommand,
  recoverConcurrentCommand,
  toD1Statement,
} from "../db";
import { commands, denialFacts } from "../db/schema";
import { UserId } from "../domain";
import * as SecurityAudit from "./security-audit";

/** Stable identity for one current denial fact. */
export const DenialFactId = Schema.String.pipe(Schema.brand("DenialFactId"));

/** Stable identity for one current denial fact. */
export type DenialFactId = typeof DenialFactId.Type;

/** Opaque identity of the resource denied by one denial fact. */
export const DeniedResourceId = Schema.String.pipe(Schema.brand("DeniedResourceId"));

/** Opaque identity of the resource denied by one denial fact. */
export type DeniedResourceId = typeof DeniedResourceId.Type;

/** Named v1 facts that deny otherwise eligible protected operations. */
export const DenialKind = Schema.Literals([
  "auth_session_revocation",
  "channel_binding_revocation",
  "deletion_request",
  "user_suspension",
]);

/** Named v1 facts that deny otherwise eligible protected operations. */
export type DenialKind = typeof DenialKind.Type;

/** Content-free fact that blocks protected operations for one User or resource. */
export const DenialFact = Schema.Struct({
  denialFactId: DenialFactId,
  kind: DenialKind,
  occurredAt: Schema.String,
  resourceId: DeniedResourceId,
  userId: UserId,
});

/** Content-free fact that blocks protected operations for one User or resource. */
export type DenialFact = typeof DenialFact.Type;

/** Complete deterministic input for recording one denial fact. */
export const RecordInput = Schema.Struct({
  commandId: DbCommandId,
  denialFactId: DenialFactId,
  kind: DenialKind,
  occurredAt: DbTimestamp,
  resourceId: DeniedResourceId,
  userId: UserId,
});

/** Complete deterministic input for recording one denial fact. */
export type RecordInput = typeof RecordInput.Type;

/** Expected invariant failure when a command exists without its denial fact. */
export class DenialFactNotFound extends Schema.TaggedError<DenialFactNotFound>()(
  "DenialFactNotFound",
  { denialFactId: DenialFactId, message: Schema.String },
) {}

/** Read the current denial facts for one User. */
export const readForUser = Effect.fn("DenialFacts.readForUser")(function* (userId: UserId) {
  const db = yield* database;
  const rows = yield* db
    .select({
      denialFactId: denialFacts.denialFactId,
      kind: denialFacts.kind,
      occurredAt: denialFacts.occurredAt,
      resourceId: denialFacts.resourceId,
      userId: denialFacts.userId,
    })
    .from(denialFacts)
    .where(eq(denialFacts.userId, userId))
    .orderBy(asc(denialFacts.occurredAt), asc(denialFacts.denialFactId))
    .pipe(Effect.mapError((cause) => dbUnavailable("readDenialFacts", cause)));
  return yield* decodeRow(Schema.Array(DenialFact), rows, "readDenialFacts");
});

/** Record one content-free denial fact for deterministic authorization. */
export const record = Effect.fn("DenialFacts.record")(function* (input: RecordInput) {
  const db = yield* database;
  const command = yield* fingerprintCommand("recordDenialFact", input.commandId, [
    "record_denial_fact",
    input.denialFactId,
    input.kind,
    input.occurredAt,
    input.resourceId,
    input.userId,
  ]);
  const existingCommand = yield* findCommand(db, input.commandId, "recordDenialFact").pipe(
    Effect.mapError((cause) => dbUnavailable("recordDenialFact", cause)),
  );
  if (existingCommand !== undefined) {
    if (existingCommand.requestDigest !== command.requestDigest) {
      return yield* dbCommandConflict(input.commandId);
    }
    return yield* readFact(input.denialFactId);
  }

  const inserts = [
    db.insert(commands).values({
      commandId: input.commandId,
      completedAt: input.occurredAt,
      operation: "record_denial_fact",
      requestDigest: command.requestDigest,
    }),
    db.insert(denialFacts).values(input),
    SecurityAudit.denialRecorded(db, input),
  ];

  const concurrentResult = yield* db.$client
    .batch(inserts.map((query) => toD1Statement(db, query)))
    .pipe(
      Effect.as<DenialFact | undefined>(undefined),
      Effect.catch((cause) =>
        recoverConcurrentCommand(
          findCommand(db, input.commandId, "recordDenialFact"),
          command,
          cause,
          "recordDenialFact",
          readFact(input.denialFactId),
        ),
      ),
    );
  return concurrentResult ?? fromInput(input);
});

const readFact = (denialFactId: DenialFactId) =>
  Effect.gen(function* () {
    const db = yield* database;
    const rows = yield* db
      .select({
        denialFactId: denialFacts.denialFactId,
        kind: denialFacts.kind,
        occurredAt: denialFacts.occurredAt,
        resourceId: denialFacts.resourceId,
        userId: denialFacts.userId,
      })
      .from(denialFacts)
      .where(eq(denialFacts.denialFactId, denialFactId))
      .limit(1)
      .pipe(Effect.mapError((cause) => dbUnavailable("recordDenialFact", cause)));
    const fact = rows[0];
    if (fact === undefined) {
      return yield* new DenialFactNotFound({
        denialFactId,
        message: "The command exists without its required denial fact",
      });
    }
    return yield* decodeRow(DenialFact, fact, "recordDenialFact");
  });

const fromInput = (input: RecordInput): DenialFact => ({
  denialFactId: input.denialFactId,
  kind: input.kind,
  occurredAt: input.occurredAt,
  resourceId: input.resourceId,
  userId: input.userId,
});
