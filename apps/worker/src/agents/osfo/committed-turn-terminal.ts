import { Option, Schema } from "effect";

import { ThinkRequestId } from "../../domain";

/** Durable Think terminal evidence used to recover capture after a Worker restart. */
export const CommittedTurnTerminal = Schema.Struct({
  requestId: ThinkRequestId,
  status: Schema.Literals(["completed", "error", "aborted"]),
});

/** Durable Think terminal evidence used to recover capture after a Worker restart. */
export interface CommittedTurnTerminal extends Schema.Schema.Type<typeof CommittedTurnTerminal> {}

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
