import { Effect, Option, Schema } from "effect";

import {
  AllowancePeriodId,
  SessionId,
  ThinkRequestId,
  ThinkSubmissionId,
  UserId,
} from "../../domain";

/** Minimal trusted authority retained for post-commit conversation projection. */
export const CommittedTurnAttribution = Schema.Struct({
  allowancePeriodId: AllowancePeriodId,
  executionMode: Schema.optionalKey(Schema.Literals(["exhaustedConversation", "normalPlanUsage"])),
  sessionId: SessionId,
  userId: UserId,
});

/** Minimal trusted authority retained for post-commit conversation projection. */
export interface CommittedTurnAttribution extends Schema.Schema.Type<
  typeof CommittedTurnAttribution
> {}

/** Durable Think terminal evidence used to recover capture after a Worker restart. */
export const CommittedTurnTerminal = Schema.Struct({
  attribution: Schema.optionalKey(CommittedTurnAttribution),
  requestId: ThinkRequestId,
  status: Schema.Literals(["completed", "error", "aborted"]),
  submissionId: Schema.optionalKey(ThinkSubmissionId),
});

/** Durable Think terminal evidence used to recover capture after a Worker restart. */
export interface CommittedTurnTerminal extends Schema.Schema.Type<typeof CommittedTurnTerminal> {}

/** Expected dependency failure while persisting Think's terminal message. */
export class ThinkTerminalPersistenceUnavailable extends Schema.TaggedError<ThinkTerminalPersistenceUnavailable>()(
  "ThinkTerminalPersistenceUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

/** Persist Think's terminal message before fallible provider capture begins. */
export const persistThinkTerminalBeforeCapture = Effect.fn(
  "CommittedTurnTerminal.persistBeforeCapture",
)(function* <A, E, R, Persisted>(
  persistTerminal: () => Promise<Persisted>,
  capture: Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E | ThinkTerminalPersistenceUnavailable, R> {
  yield* Effect.tryPromise({
    try: persistTerminal,
    catch: (cause) =>
      new ThinkTerminalPersistenceUnavailable({
        cause,
        message: "Think terminal persistence is unavailable",
      }),
  });
  return yield* capture;
});

const MessageMetadata = Schema.StructWithRest(
  Schema.Struct({ osfoCommittedTurn: CommittedTurnTerminal }),
  [Schema.JsonObject],
);

/* oxlint-disable osfo/no-unknown-parameters -- These helpers own the external and persisted Think UIMessage metadata boundaries and decode them before use. */
/** Preserve SDK-owned metadata while adding Osfo's terminal marker. */
export const withCommittedTurnTerminal = (metadata: unknown, terminal: CommittedTurnTerminal) =>
  MessageMetadata.make({
    ...Option.getOrElse(Schema.decodeUnknownOption(Schema.JsonObject)(metadata), () => ({})),
    osfoCommittedTurn: terminal,
  });

/** Decode only trusted Osfo terminal evidence from persisted message metadata. */
export const readCommittedTurnTerminal = (
  metadata: unknown,
): Option.Option<CommittedTurnTerminal> =>
  Option.map(
    Schema.decodeUnknownOption(MessageMetadata)(metadata),
    ({ osfoCommittedTurn }) => osfoCommittedTurn,
  );
/* oxlint-enable osfo/no-unknown-parameters */
