import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { DbTimestamp } from "../../db";
import {
  AgentId,
  AllowancePeriodId,
  ChannelLinkId,
  ConversationRouteId,
  SessionId,
  ThinkSubmissionId,
  UserId,
} from "../../domain";
import { ManagedTurnMetadata } from "../../domain/managed-conversation";
import type { AgentDb } from "./db/client";
import { messengerAcceptanceReceipts } from "./db/schema";

/** Persist the original owner before an admission RPC can commit a native submission. */
export const MessengerAdmissionRoute = Schema.Struct({
  agentId: AgentId,
  channelLinkId: ChannelLinkId,
  kind: Schema.Literal("route"),
  userId: UserId,
});

/** The immutable mapping returned only after the native submission is recoverable. */
export const MessengerAcceptanceReceipt = Schema.Struct({
  acceptedAt: DbTimestamp,
  agentId: AgentId,
  inputDigest: Schema.String,
  allowancePeriodId: AllowancePeriodId,
  channelLinkId: ChannelLinkId,
  kind: Schema.Literal("submission"),
  turnMetadata: ManagedTurnMetadata,
  provider: Schema.Literals(["telegram", "whatsapp"]),
  providerMessageId: Schema.String,
  routeId: ConversationRouteId,
  sessionId: SessionId,
  submissionId: ThinkSubmissionId,
  threadId: Schema.String,
  userId: UserId,
  userMessageId: Schema.String,
});

export type MessengerAcceptanceReceipt = typeof MessengerAcceptanceReceipt.Type;

export class MessengerAdmissionUnavailable extends Schema.TaggedError<MessengerAdmissionUnavailable>()(
  "MessengerAdmissionUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

const receiptJson = Schema.fromJsonString(MessengerAcceptanceReceipt);

/** Own exact-input replay and receipt immutability in the accepting Agent database. */
export const makeMessengerAdmissionStore = (db: AgentDb) => ({
  read: Effect.fn("MessengerAdmission.read")(function* (
    submissionId: ThinkSubmissionId,
    inputDigest: string,
  ) {
    const row = yield* Effect.try({
      try: () =>
        db
          .select()
          .from(messengerAcceptanceReceipts)
          .where(eq(messengerAcceptanceReceipts.submission_id, submissionId))
          .get(),
      catch: (cause) => unavailable(cause),
    });
    if (row === undefined) return null;
    if (row.input_digest !== inputDigest)
      return yield* unavailable(
        new Error("Provider message identity was reused for different input"),
      );
    return yield* Schema.decodeEffect(receiptJson)(row.receipt_json).pipe(
      Effect.mapError(unavailable),
    );
  }),
  record: Effect.fn("MessengerAdmission.record")(function* (
    receipt: MessengerAcceptanceReceipt,
    inputDigest: string,
  ) {
    const encoded = yield* Schema.encodeEffect(receiptJson)(receipt).pipe(
      Effect.mapError(unavailable),
    );
    const retained = yield* Effect.try({
      try: () =>
        db.transaction((transaction) => {
          transaction
            .insert(messengerAcceptanceReceipts)
            .values({
              input_digest: inputDigest,
              receipt_json: encoded,
              session_id: receipt.sessionId,
              submission_id: receipt.submissionId,
            })
            .onConflictDoNothing()
            .run();
          return transaction
            .select()
            .from(messengerAcceptanceReceipts)
            .where(eq(messengerAcceptanceReceipts.submission_id, receipt.submissionId))
            .get();
        }),
      catch: unavailable,
    });
    if (
      retained === undefined ||
      retained.input_digest !== inputDigest ||
      retained.receipt_json !== encoded
    ) {
      return yield* unavailable(new Error("Acceptance receipt cannot be changed"));
    }
    return receipt;
  }),
});

const unavailable = (cause: unknown) =>
  new MessengerAdmissionUnavailable({
    cause,
    message: "Messenger input could not be durably accepted",
  });
