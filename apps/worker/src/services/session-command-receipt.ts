import { Schema } from "effect";

import {
  AcceptanceReceiptId,
  AllowancePeriodId,
  ChannelBindingId,
  ConversationRouteId,
  ProviderMessageId,
  SessionId,
  UserMessageId,
} from "../domain";
import { AcceptanceTimestamp } from "./provider-acceptance-receipt";

/** Stable facts for one accepted Session replacement command. */
export const SessionCommandReceiptInput = Schema.Struct({
  allowancePeriodId: AllowancePeriodId,
  channelBindingId: ChannelBindingId,
  command: Schema.Literal("/new"),
  providerMessageId: ProviderMessageId,
  receiptId: AcceptanceReceiptId,
  userMessageId: UserMessageId,
});

/** Stable facts for one accepted Session replacement command. */
export type SessionCommandReceiptInput = typeof SessionCommandReceiptInput.Type;

/** Immutable terminal evidence for one accepted Session command. */
export const SessionCommandReceipt = Schema.TaggedStruct("SessionCommandReceipt", {
  ...SessionCommandReceiptInput.fields,
  acceptedAt: AcceptanceTimestamp,
  currentSessionId: SessionId,
  historicalSessionId: SessionId,
  routeId: ConversationRouteId,
});

/** Immutable terminal evidence for one accepted Session command. */
export type SessionCommandReceipt = typeof SessionCommandReceipt.Type;

/** Expected conflict when one Channel Message Key names changed Session command facts. */
export class SessionCommandReceiptConflict extends Schema.TaggedError<SessionCommandReceiptConflict>()(
  "SessionCommandReceiptConflict",
  {
    existingReceiptId: AcceptanceReceiptId,
    existingReplacementSessionId: SessionId,
    existingUserMessageId: UserMessageId,
    message: Schema.String,
    providerMessageId: ProviderMessageId,
    receiptId: AcceptanceReceiptId,
    requestedReplacementSessionId: SessionId,
    userMessageId: UserMessageId,
  },
) {}
