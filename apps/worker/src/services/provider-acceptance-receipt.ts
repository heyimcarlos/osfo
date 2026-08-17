import { DateTime, Option, Schema } from "effect";

import {
  AcceptanceReceiptId,
  AllowancePeriodId,
  ChannelBindingId,
  ProviderMessageId,
  SessionId,
  ThinkSubmissionId,
  UserMessageId,
} from "../domain";

const utcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

/** Stable facts mapping one accepted provider message to its canonical Think Session. */
export const AcceptanceReceiptInput = Schema.Struct({
  allowancePeriodId: AllowancePeriodId,
  channelBindingId: ChannelBindingId,
  providerMessageId: ProviderMessageId,
  receiptId: AcceptanceReceiptId,
  sessionId: SessionId,
  thinkSubmissionId: ThinkSubmissionId,
  userMessageId: UserMessageId,
});

/** Stable receipt facts before the persistence adapter adds its acceptance timestamp. */
export type AcceptanceReceiptInput = typeof AcceptanceReceiptInput.Type;

/** UTC timestamp stored on immutable provider acceptance evidence. */
export const AcceptanceTimestamp = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (utcTimestamp.test(value) && Option.isSome(DateTime.make(value))) ||
      "must be a valid UTC timestamp",
  ),
).pipe(Schema.brand("AcceptanceTimestamp"));

/** Immutable durable evidence for one accepted provider message. */
export const AcceptanceReceipt = Schema.TaggedStruct("AcceptanceReceipt", {
  ...AcceptanceReceiptInput.fields,
  acceptedAt: AcceptanceTimestamp,
});

/** Durable proof that one provider message reached one canonical Think Session. */
export type AcceptanceReceipt = typeof AcceptanceReceipt.Type;
