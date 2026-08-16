import { Schema } from "effect";

import { SessionId } from "../../../domain";

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
    message: Schema.String,
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
    message: Schema.String,
  },
) {}

/** Expected failure when one committed-turn key names conflicting projection facts. */
export class CommittedTurnConflict extends Schema.TaggedError<CommittedTurnConflict>()(
  "CommittedTurnConflict",
  {
    assistantMessageId: Schema.String,
    message: Schema.String,
    sessionId: SessionId,
    thinkRequestId: Schema.NullOr(Schema.String),
  },
) {}
