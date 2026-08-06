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
  AdmissionUnavailable,
  CapacityRejected,
  IdempotencyConflict,
  SubmitMessagePayload,
  ThreadHistoryPage,
  ThreadStreamEvent,
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
