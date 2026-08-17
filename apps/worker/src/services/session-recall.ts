import { Duration, Effect, Schema } from "effect";

import { ConversationRouteId, SessionId } from "../domain";
import { AuthorizationDenialReason } from "./authorization";
import type { SessionLifecycleNotFound } from "./session-lifecycle";

const maximumRecallResults = 20;
const maximumRecallSessions = 20;
const recallDeadline = Duration.millis(1_000);
const recallDeadlineMillis = 1_000;

/** Opaque handle for one model-invoked Session Recall continuation. */
export const SessionRecallCursor = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu),
).pipe(Schema.brand("SessionRecallCursor"));

/** Globally bounded result count for one recall invocation. */
export const SessionRecallLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(maximumRecallResults),
).pipe(Schema.brand("SessionRecallLimit"));

/** Non-empty bounded exact lexical recall query. */
export const SessionRecallQuery = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
  Schema.isPattern(/\S/u),
).pipe(Schema.brand("SessionRecallQuery"));

/** Opaque recall continuation handle. */
export type SessionRecallCursor = typeof SessionRecallCursor.Type;
/** Globally bounded recall result count. */
export type SessionRecallLimit = typeof SessionRecallLimit.Type;
/** Bounded exact lexical recall query. */
export type SessionRecallQuery = typeof SessionRecallQuery.Type;

/** Expected failure when Think Session search is unavailable. */
export class SessionRecallUnavailable extends Schema.TaggedError<SessionRecallUnavailable>()(
  "SessionRecallUnavailable",
  { cause: Schema.Defect(), message: Schema.String, sessionId: SessionId },
) {}

/** Expected failure when Think returns an invalid recall record. */
export class SessionRecallRecordInvalid extends Schema.TaggedError<SessionRecallRecordInvalid>()(
  "SessionRecallRecordInvalid",
  { message: Schema.String, sessionId: SessionId },
) {}

/** Expected failure when recall exceeds its one-second budget. */
export class SessionRecallTimedOut extends Schema.TaggedError<SessionRecallTimedOut>()(
  "SessionRecallTimedOut",
  {
    cursor: Schema.NullOr(SessionRecallCursor),
    deadlineMillis: Schema.Int.check(Schema.isGreaterThan(0)),
    message: Schema.String,
    routeId: ConversationRouteId,
  },
) {}

/** Expected failure when a recall handle is unknown, expired, or route-bound elsewhere. */
export class SessionRecallCursorInvalid extends Schema.TaggedError<SessionRecallCursorInvalid>()(
  "SessionRecallCursorInvalid",
  { cursor: SessionRecallCursor, message: Schema.String },
) {}

/** Expected failure when Agent-owned recall paging storage is unavailable or invalid. */
export class SessionRecallStoreUnavailable extends Schema.TaggedError<SessionRecallStoreUnavailable>()(
  "SessionRecallStoreUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Expected denial when current Session Recall authorization no longer permits access. */
export class SessionRecallAuthorizationDenied extends Schema.TaggedError<SessionRecallAuthorizationDenied>()(
  "SessionRecallAuthorizationDenied",
  {
    message: Schema.String,
    reason: AuthorizationDenialReason,
    routeId: ConversationRouteId,
    sessionId: SessionId,
  },
) {}

/** Expected failure when current Session Recall authorization facts cannot be refreshed. */
export class SessionRecallAuthorizationUnavailable extends Schema.TaggedError<SessionRecallAuthorizationUnavailable>()(
  "SessionRecallAuthorizationUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** One parsed exact lexical match from Think Session storage. */
export interface SessionRecallMatch {
  readonly content: string;
  readonly messageId: string;
  readonly role: string;
}

/** One route-owned recall result with its Session state. */
export interface SessionRecallResult extends SessionRecallMatch {
  readonly sessionId: SessionId;
  readonly sessionState: "current" | "historical";
}

/** One validated model-invoked recall request. */
export interface SessionRecallRequest {
  readonly cursor: SessionRecallCursor | null;
  readonly limit: SessionRecallLimit;
  readonly query: SessionRecallQuery;
  readonly routeId: ConversationRouteId;
}

/** Successful bounded recall result page. */
export interface SessionRecallCompleted {
  readonly _tag: "SessionRecallCompleted";
  readonly currentSessionId: SessionId;
  readonly nextCursor: SessionRecallCursor | null;
  readonly results: ReadonlyArray<SessionRecallResult>;
  readonly routeId: ConversationRouteId;
}

/** One Session candidate and its stable continuation handle. */
export interface SessionRecallCandidate {
  readonly cursor: SessionRecallCursor;
  readonly sessionId: SessionId;
}

/** One bounded route ownership page. */
export interface SessionRecallCandidatePage {
  readonly candidates: ReadonlyArray<SessionRecallCandidate>;
  readonly currentSessionId: SessionId;
  readonly hasMore: boolean;
  readonly routeId: ConversationRouteId;
}

/** Agent-owned recall paging persistence port. */
export interface SessionRecallStore {
  readonly readRecallPage: (
    routeId: ConversationRouteId,
    cursor: SessionRecallCursor | null,
    limit: SessionRecallLimit,
  ) => Effect.Effect<
    SessionRecallCandidatePage,
    SessionLifecycleNotFound | SessionRecallCursorInvalid | SessionRecallStoreUnavailable
  >;
}

/** Think exact lexical search port. */
export interface SessionRecallSearch {
  readonly search: (
    sessionId: SessionId,
    query: SessionRecallQuery,
    limit: SessionRecallLimit,
  ) => Effect.Effect<
    ReadonlyArray<SessionRecallMatch>,
    SessionRecallUnavailable | SessionRecallRecordInvalid
  >;
}

/** Dependencies for bounded Session Recall. */
export interface SessionRecallDependencies {
  readonly search: SessionRecallSearch;
  readonly store: SessionRecallStore;
}

/** Model-only bounded Session Recall policy. */
export interface SessionRecall {
  readonly recall: (
    request: SessionRecallRequest,
  ) => Effect.Effect<
    SessionRecallCompleted,
    | SessionLifecycleNotFound
    | SessionRecallCursorInvalid
    | SessionRecallStoreUnavailable
    | SessionRecallUnavailable
    | SessionRecallRecordInvalid
    | SessionRecallTimedOut
  >;
}

interface SearchProgress {
  readonly cursor: SessionRecallCursor | null;
  readonly results: ReadonlyArray<SessionRecallResult>;
  readonly searchedCandidates: number;
}

/** Construct globally bounded lexical Session Recall policy. */
export const makeSessionRecall = (dependencies: SessionRecallDependencies): SessionRecall => {
  const searchCandidates = (
    candidates: ReadonlyArray<SessionRecallCandidate>,
    currentSessionId: SessionId,
    progress: SearchProgress,
    query: SessionRecallQuery,
    limit: SessionRecallLimit,
  ): Effect.Effect<SearchProgress, SessionRecallUnavailable | SessionRecallRecordInvalid> => {
    const candidate = candidates[0];
    const remaining = limit - progress.results.length;
    if (candidate === undefined || remaining <= 0) return Effect.succeed(progress);
    return dependencies.search
      .search(candidate.sessionId, query, SessionRecallLimit.make(remaining))
      .pipe(
        Effect.map((found) =>
          found.map((match): SessionRecallResult => ({
            ...match,
            sessionId: candidate.sessionId,
            sessionState: candidate.sessionId === currentSessionId ? "current" : "historical",
          })),
        ),
        Effect.flatMap((found) =>
          searchCandidates(
            candidates.slice(1),
            currentSessionId,
            {
              cursor: candidate.cursor,
              results: [...progress.results, ...found].slice(0, limit),
              searchedCandidates: progress.searchedCandidates + 1,
            },
            query,
            limit,
          ),
        ),
      );
  };

  return {
    recall: (request) =>
      Effect.gen(function* () {
        const page = yield* dependencies.store.readRecallPage(
          request.routeId,
          request.cursor,
          SessionRecallLimit.make(maximumRecallSessions),
        );
        const progress = yield* searchCandidates(
          page.candidates,
          page.currentSessionId,
          { cursor: null, results: [], searchedCandidates: 0 },
          request.query,
          request.limit,
        );
        return {
          _tag: "SessionRecallCompleted",
          currentSessionId: page.currentSessionId,
          nextCursor:
            progress.searchedCandidates < page.candidates.length || page.hasMore
              ? progress.cursor
              : null,
          results: progress.results,
          routeId: page.routeId,
        } as const;
      }).pipe(
        Effect.timeoutOrElse({
          duration: recallDeadline,
          orElse: () =>
            Effect.fail(
              new SessionRecallTimedOut({
                cursor: request.cursor,
                deadlineMillis: recallDeadlineMillis,
                message: "Session Recall exceeded its global latency budget",
                routeId: request.routeId,
              }),
            ),
        }),
      ),
  };
};
