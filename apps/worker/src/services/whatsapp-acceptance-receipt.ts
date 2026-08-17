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

/** Stable facts required to map one accepted WhatsApp message to Think. */
export const AcceptanceReceiptInput = Schema.Struct({
  allowancePeriodId: AllowancePeriodId,
  channelBindingId: ChannelBindingId,
  providerMessageId: ProviderMessageId,
  receiptId: AcceptanceReceiptId,
  sessionId: SessionId,
  thinkSubmissionId: ThinkSubmissionId,
  userMessageId: UserMessageId,
});

/** Stable facts required to map one accepted WhatsApp message to Think. */
export type AcceptanceReceiptInput = typeof AcceptanceReceiptInput.Type;

const AcceptanceTimestamp = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (utcTimestamp.test(value) && Option.isSome(DateTime.make(value))) ||
      "must be a valid UTC timestamp",
  ),
).pipe(Schema.brand("AcceptanceTimestamp"));

/** Immutable durable evidence for one accepted Channel Message Key. */
export const AcceptanceReceipt = Schema.TaggedStruct("AcceptanceReceipt", {
  ...AcceptanceReceiptInput.fields,
  acceptedAt: AcceptanceTimestamp,
});

/** Immutable durable evidence for one accepted Channel Message Key. */
export type AcceptanceReceipt = typeof AcceptanceReceipt.Type;
