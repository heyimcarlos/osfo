import type { ThreadSnapshot } from "@osfo/session";
import { Context, type Effect, type Stream } from "effect";
import type {
  AcceptanceReceipt,
  AdmissionUnavailable,
  AuthenticationRejected,
  CapacityRejected,
  IdempotencyConflict,
  SubmitMessagePayload,
  ThreadHistoryPage,
  ThreadNotFound,
  ThreadStreamEvent,
  TraversalUnavailable,
  InvalidCursor,
  CursorOutsideRetention,
  SnapshotUnavailable,
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
export type ThreadTraversalError =
  | AuthenticationRejected
  | ThreadNotFound
  | InvalidCursor
  | CursorOutsideRetention
  | TraversalUnavailable;

export interface ThreadTraversalService {
  readonly snapshot: (request: ThreadAccess) => Effect.Effect<ThreadSnapshot, ThreadSnapshotError>;
  readonly history: (
    request: ThreadHistoryRequest,
  ) => Effect.Effect<
    ThreadHistoryPage,
    AuthenticationRejected | ThreadNotFound | TraversalUnavailable
  >;
  readonly stream: (
    request: ThreadStreamRequest,
  ) => Effect.Effect<Stream.Stream<ThreadStreamEvent, TraversalUnavailable>, ThreadTraversalError>;
}

export class ThreadTraversal extends Context.Service<ThreadTraversal, ThreadTraversalService>()(
  "@osfo/api/ThreadTraversal",
) {}
