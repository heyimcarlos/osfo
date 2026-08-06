import { Context, type Effect } from "effect";
import type {
  AcceptanceReceipt,
  AdmissionUnavailable,
  AuthenticationRejected,
  CapacityRejected,
  IdempotencyConflict,
  SubmitMessagePayload,
  ThreadNotFound,
} from "./threads/api.js";

export interface SubmitMessageCommand extends SubmitMessagePayload {
  readonly authenticationToken: string;
  readonly threadId: string;
}

export type MessageAdmissionError =
  | AuthenticationRejected
  | ThreadNotFound
  | IdempotencyConflict
  | CapacityRejected
  | AdmissionUnavailable;

export class MessageAdmission extends Context.Service<
  MessageAdmission,
  {
    readonly accept: (
      command: SubmitMessageCommand,
    ) => Effect.Effect<AcceptanceReceipt, MessageAdmissionError>;
  }
>()("@osfo/api/MessageAdmission") {}
