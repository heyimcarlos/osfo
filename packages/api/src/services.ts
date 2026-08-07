import type { ThreadSnapshot } from "@osfo/session";
import { Context, Schema, type Effect, type Stream } from "effect";
import {
  AuthenticationRejected,
  CursorOutsideRetention,
  InvalidCursor,
  SnapshotUnavailable,
  ThreadNotFound,
  ThreadResumeUnavailable,
} from "./threads/api.js";
import type {
  AcceptanceReceipt,
  AdmissionCommitUnknown,
  AdmissionNotAccepted,
  AdmissionUnavailable,
  CapacityRejected,
  IdempotencyConflict,
  SubmitMessagePayload,
  ThreadHistoryPage,
  ThreadStreamEvent,
} from "./threads/api.js";

export const AdmissionCapacityReconciliationSchema = Schema.Struct({
  expectedNonTerminalCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  globalReservedBefore: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  globalReservedAfter: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  principalMismatchCountBefore: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  principalMismatchCountAfter: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reservationMismatchCountBefore: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reservationMismatchCountAfter: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  repaired: Schema.Boolean,
  sweepComplete: Schema.Boolean,
});

export type AdmissionCapacityReconciliation = typeof AdmissionCapacityReconciliationSchema.Type;

export interface SubmitMessageCommand extends SubmitMessagePayload {
  readonly authenticationToken: string;
  readonly threadId: string;
}

export type MessageAdmissionError =
  | AuthenticationRejected
  | ThreadNotFound
  | IdempotencyConflict
  | CapacityRejected
  | AdmissionNotAccepted
  | AdmissionUnavailable
  | AdmissionCommitUnknown;

export type MessageAdmissionReconciliationError =
  | AuthenticationRejected
  | ThreadNotFound
  | IdempotencyConflict
  | AdmissionNotAccepted
  | AdmissionCommitUnknown;

export class MessageAdmission extends Context.Service<
  MessageAdmission,
  {
    readonly accept: (
      command: SubmitMessageCommand,
    ) => Effect.Effect<AcceptanceReceipt, MessageAdmissionError>;
    readonly reconcile: (
      command: SubmitMessageCommand,
    ) => Effect.Effect<AcceptanceReceipt, MessageAdmissionReconciliationError>;
    readonly reconcileCapacity: () => Effect.Effect<
      AdmissionCapacityReconciliation,
      AdmissionUnavailable
    >;
  }
>()("@osfo/api/MessageAdmission") {}

export interface ThreadAccess {
  readonly authenticationToken: string;
  readonly threadId: string;
}

export interface ThreadHistoryRequest extends ThreadAccess {
  readonly afterPosition: string;
  readonly throughPosition?: string;
  readonly limit: number;
}

export interface ThreadStreamRequest extends ThreadAccess {
  readonly after: string;
}

export type ThreadSnapshotError = AuthenticationRejected | ThreadNotFound | SnapshotUnavailable;
export type ThreadResumeError =
  | AuthenticationRejected
  | ThreadNotFound
  | InvalidCursor
  | CursorOutsideRetention
  | ThreadResumeUnavailable;

export const isThreadSnapshotError = Schema.is(
  Schema.Union([AuthenticationRejected, ThreadNotFound, SnapshotUnavailable]),
);

export const isThreadResumeError = Schema.is(
  Schema.Union([
    AuthenticationRejected,
    ThreadNotFound,
    InvalidCursor,
    CursorOutsideRetention,
    ThreadResumeUnavailable,
  ]),
);

export interface ThreadResumeService {
  readonly snapshot: (request: ThreadAccess) => Effect.Effect<ThreadSnapshot, ThreadSnapshotError>;
  readonly history: (
    request: ThreadHistoryRequest,
  ) => Effect.Effect<
    ThreadHistoryPage,
    AuthenticationRejected | ThreadNotFound | ThreadResumeUnavailable
  >;
  readonly stream: (
    request: ThreadStreamRequest,
  ) => Effect.Effect<Stream.Stream<ThreadStreamEvent, ThreadResumeUnavailable>, ThreadResumeError>;
}

export class ThreadResume extends Context.Service<ThreadResume, ThreadResumeService>()(
  "@osfo/api/ThreadResume",
) {}
