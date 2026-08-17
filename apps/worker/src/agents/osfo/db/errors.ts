import { Schema } from "effect";

import { DbTimestamp } from "../../../db";
import {
  AgentId,
  AgentInitializationId,
  AssistantMessageId,
  ConversationRouteId,
  SessionId,
  ThinkRequestId,
} from "../../../domain";

/** Agent SQLite operations exposed by the typed store seam. */
export const AgentStoreOperation = Schema.Literals([
  "initialize",
  "inspect",
  "readRoute",
  "readSessionOwnership",
  "replaceCurrentSession",
  "recordCommittedTurn",
  "readCommittedTurns",
]);

/** Agent SQLite operations exposed by the typed store seam. */
export type AgentStoreOperation = typeof AgentStoreOperation.Type;

/** Expected failure when an applied migration digest differs from this release. */
export class AgentMigrationDigestMismatch extends Schema.TaggedError<AgentMigrationDigestMismatch>()(
  "AgentMigrationDigestMismatch",
  {
    actualDigest: Schema.String,
    expectedDigest: Schema.String,
    message: Schema.String,
    version: Schema.Int,
  },
) {}

/** Expected failure when generated migration SQL differs from its verified manifest. */
export class AgentMigrationDefinitionMismatch extends Schema.TaggedError<AgentMigrationDefinitionMismatch>()(
  "AgentMigrationDefinitionMismatch",
  {
    actualDigest: Schema.String,
    expectedDigest: Schema.String,
    message: Schema.String,
    version: Schema.Int,
  },
) {}

/** Expected failure when Agent SQLite rejects a migration operation. */
export class AgentMigrationFailed extends Schema.TaggedError<AgentMigrationFailed>()(
  "AgentMigrationFailed",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    version: Schema.Natural,
  },
) {}

/** Expected failure when the stored migration history is not a supported prefix. */
export class AgentMigrationHistoryUnsupported extends Schema.TaggedError<AgentMigrationHistoryUnsupported>()(
  "AgentMigrationHistoryUnsupported",
  {
    message: Schema.String,
    version: Schema.Natural,
  },
) {}

/** Expected failures from the Agent SQLite migration coordinator. */
export type AgentMigrationError =
  | AgentMigrationDefinitionMismatch
  | AgentMigrationDigestMismatch
  | AgentMigrationFailed
  | AgentMigrationHistoryUnsupported;

/** Expected failure when Agent initialization conflicts with established facts. */
export class AgentInitializationConflict extends Schema.TaggedError<AgentInitializationConflict>()(
  "AgentInitializationConflict",
  {
    existingAgentId: Schema.NullOr(AgentId),
    existingInitializationId: Schema.NullOr(AgentInitializationId),
    existingInitializedAt: Schema.NullOr(DbTimestamp),
    existingRouteId: Schema.NullOr(ConversationRouteId),
    existingSessionId: Schema.NullOr(SessionId),
    message: Schema.String,
    namedAgentId: AgentId,
    requestedAgentId: AgentId,
    requestedInitializationId: AgentInitializationId,
    requestedInitializedAt: DbTimestamp,
    requestedRouteId: ConversationRouteId,
    requestedSessionId: SessionId,
  },
) {}

/** Expected failure when a route or Session identity is not Agent-owned. */
export class AgentStateNotFound extends Schema.TaggedError<AgentStateNotFound>()(
  "AgentStateNotFound",
  {
    message: Schema.String,
    subject: Schema.Literals(["agent", "route", "session"]),
  },
) {}

/** Expected failure when a Session replacement does not match current state. */
export class CurrentSessionReplacementConflict extends Schema.TaggedError<CurrentSessionReplacementConflict>()(
  "CurrentSessionReplacementConflict",
  {
    actualCurrentSessionId: Schema.NullOr(SessionId),
    expectedCurrentSessionId: SessionId,
    message: Schema.String,
    replacementOwnerRouteId: Schema.NullOr(ConversationRouteId),
    replacementSessionId: SessionId,
    routeId: ConversationRouteId,
  },
) {}

/** Expected failure when one committed-turn key names conflicting observation facts. */
export class CommittedTurnConflict extends Schema.TaggedError<CommittedTurnConflict>()(
  "CommittedTurnConflict",
  {
    assistantMessageId: AssistantMessageId,
    existingAssistantMessageId: AssistantMessageId,
    existingSessionId: SessionId,
    existingThinkRequestId: Schema.NullOr(ThinkRequestId),
    message: Schema.String,
    sessionId: SessionId,
    thinkRequestId: Schema.NullOr(ThinkRequestId),
  },
) {}

/** Expected dependency failure when Think Session history cannot be read. */
export class ThinkSessionReadUnavailable extends Schema.TaggedError<ThinkSessionReadUnavailable>()(
  "ThinkSessionReadUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    sessionId: SessionId,
  },
) {}

/** Expected dependency failure when a personal welcome cannot be persisted. */
export class ThinkSessionWriteUnavailable extends Schema.TaggedError<ThinkSessionWriteUnavailable>()(
  "ThinkSessionWriteUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    sessionId: SessionId,
  },
) {}

/** Expected failure when Think returns a malformed Session history record. */
export class ThinkSessionRecordInvalid extends Schema.TaggedError<ThinkSessionRecordInvalid>()(
  "ThinkSessionRecordInvalid",
  {
    message: Schema.String,
    sessionId: SessionId,
  },
) {}

/** Expected dependency failure at the narrow synchronous Drizzle seam. */
export class AgentStoreUnavailable extends Schema.TaggedError<AgentStoreUnavailable>()(
  "AgentStoreUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: AgentStoreOperation,
  },
) {}

/** Expected failure when Agent SQLite returns a malformed Osfo-owned record. */
export class AgentStoreRecordInvalid extends Schema.TaggedError<AgentStoreRecordInvalid>()(
  "AgentStoreRecordInvalid",
  {
    message: Schema.String,
    operation: AgentStoreOperation,
  },
) {}

/** Agent RPC operations with externally supplied values. */
export const AgentRequestOperation = Schema.Literals([
  "commitWelcome",
  "cancelManagedConversation",
  "boundCoreMemory",
  "correctCoreMemory",
  "initialize",
  "readRoute",
  "readSession",
  "replaceCurrentSession",
  "submitManagedConversation",
]);

/** Agent RPC operations with externally supplied values. */
export type AgentRequestOperation = typeof AgentRequestOperation.Type;

/** Expected failure when an Agent RPC value does not match its Effect Schema. */
export class AgentRequestInvalid extends Schema.TaggedError<AgentRequestInvalid>()(
  "AgentRequestInvalid",
  {
    message: Schema.String,
    operation: AgentRequestOperation,
  },
) {}
