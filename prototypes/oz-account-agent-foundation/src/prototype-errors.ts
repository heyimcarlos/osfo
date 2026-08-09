import * as Data from "effect/Data";

export class PrototypePersistenceError extends Data.TaggedError("PrototypePersistenceError")<{
  readonly cause: unknown;
  readonly operation: string;
}> {}

export class ChannelBindingMismatch extends Data.TaggedError("ChannelBindingMismatch")<{
  readonly actualAgentId: string | undefined;
  readonly channelIdentity: string;
  readonly expectedAgentId: string;
}> {}
