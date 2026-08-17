import { jsonSchema, tool, type ToolSet } from "ai";
import { Duration, Effect, Result, Schema } from "effect";

import type { SessionId } from "../../domain";
import type { ManagedTurnMetadata } from "../../domain/managed-conversation";
import type {
  SessionRecall,
  SessionRecallAuthorizationDenied,
  SessionRecallMatch,
  SessionRecallSearch,
} from "../../services/session-recall";
import {
  SessionRecallAuthorizationUnavailable,
  SessionRecallCursor,
  SessionRecallLimit,
  SessionRecallQuery,
  SessionRecallRecordInvalid,
  SessionRecallUnavailable,
} from "../../services/session-recall";

/* oxlint-disable effecttsgo/async-function -- AI SDK tools require a Promise boundary. */

const SessionRecallToolInput = Schema.Struct({
  cursor: Schema.optional(SessionRecallCursor),
  limit: Schema.optional(SessionRecallLimit),
  query: SessionRecallQuery,
});
interface SessionRecallToolInputEncoded {
  readonly cursor?: string;
  readonly limit?: number;
  readonly query: string;
}
const sessionRecallToolInputJsonSchema = jsonSchema<SessionRecallToolInputEncoded>({
  additionalProperties: false,
  properties: {
    cursor: {
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      type: "string",
    },
    limit: { maximum: 20, minimum: 1, type: "integer" },
    query: { maxLength: 500, minLength: 1, type: "string" },
  },
  required: ["query"],
  type: "object",
});
const defaultSessionRecallLimit = SessionRecallLimit.make(10);
const ThinkSessionRecallResult = Schema.Struct({
  content: Schema.String,
  id: Schema.String,
  role: Schema.String,
});

/** Raw Think Session search function isolated at the outbound Adapter seam. */
export type ThinkSessionSearch = (
  sessionId: SessionId,
  query: string,
  limit: number,
) => Promise<ReadonlyArray<unknown>>;

/** Parse Think search records into the application-owned Session Recall port. */
export const makeThinkSessionRecallSearch = (
  searchThinkSession: ThinkSessionSearch,
): SessionRecallSearch => ({
  search: (sessionId, query, limit) =>
    Effect.tryPromise({
      try: () => searchThinkSession(sessionId, query, limit),
      catch: (cause) =>
        new SessionRecallUnavailable({
          cause,
          message: "Think Session Recall is unavailable",
          sessionId,
        }),
    }).pipe(
      Effect.flatMap((found) =>
        Effect.forEach(found, (result) =>
          Schema.decodeUnknownEffect(ThinkSessionRecallResult)(result).pipe(
            Effect.mapError(
              () =>
                new SessionRecallRecordInvalid({
                  message: "Think Session Recall returned an invalid result",
                  sessionId,
                }),
            ),
            Effect.map((decoded): SessionRecallMatch => ({
              content: decoded.content,
              messageId: decoded.id,
              role: decoded.role,
            })),
          ),
        ),
      ),
    ),
});

/** Dependencies owned by the model-tool inbound Adapter. */
export interface SessionRecallToolDependencies {
  readonly authorize: (
    metadata: ManagedTurnMetadata,
  ) => Effect.Effect<
    void,
    SessionRecallAuthorizationDenied | SessionRecallAuthorizationUnavailable
  >;
  readonly readActiveTurn: () => ManagedTurnMetadata | undefined;
  readonly recall: SessionRecall["recall"];
}

/** Construct the model-only Session Recall tool Adapter. */
export const makeSessionRecallTools = (dependencies: SessionRecallToolDependencies): ToolSet => ({
  sessionRecall: tool({
    description:
      "Search exact words or phrases in one bounded page of the active route's current and historical Sessions. Use nextCursor to search older history.",
    execute: async (input) => {
      const decoded = Schema.decodeResult(SessionRecallToolInput)(input);
      if (Result.isFailure(decoded)) return recallUnavailable;
      const { cursor = null, limit = defaultSessionRecallLimit, query } = decoded.success;
      const activeTurn = dependencies.readActiveTurn();
      if (activeTurn === undefined) return recallUnavailable;
      return Effect.runPromise(
        dependencies.authorize(activeTurn).pipe(
          Effect.andThen(
            dependencies.recall({ cursor, limit, query, routeId: activeTurn.routeId }),
          ),
          Effect.timeoutOrElse({
            duration: Duration.millis(1_000),
            orElse: () =>
              Effect.fail(
                new SessionRecallAuthorizationUnavailable({
                  cause: "Session Recall deadline exceeded",
                  message: "Session Recall is unavailable",
                }),
              ),
          }),
          Effect.match({
            onFailure: () => recallUnavailable,
            onSuccess: (recalled) => recalled,
          }),
        ),
      );
    },
    inputSchema: sessionRecallToolInputJsonSchema,
  }),
});

const recallUnavailable = {
  _tag: "SessionRecallUnavailable",
  message: "Session Recall is unavailable",
} as const;
