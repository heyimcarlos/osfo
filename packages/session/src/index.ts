import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const Identity = Schema.String.pipe(Schema.check(Schema.isPattern(uuidPattern)));
const ThreadPosition = Schema.String.pipe(Schema.check(Schema.isPattern(/^[1-9]\d*$/u)));
const UtcTimestamp = Schema.String.pipe(Schema.check(Schema.isPattern(utcTimestampPattern)));
const ThreadCursor = Schema.String.pipe(Schema.check(Schema.isNonEmpty()));

export const TextBlockSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String.pipe(
    Schema.check(Schema.isNonEmpty()),
    Schema.check(Schema.isMaxLength(16_384)),
  ),
});

export type TextBlock = typeof TextBlockSchema.Type;

export const UserMessageAppendedSchema = Schema.Struct({
  eventId: Identity,
  eventType: Schema.Literal("UserMessageAppended"),
  eventVersion: Schema.Literal(1),
  threadId: Identity,
  threadPosition: ThreadPosition,
  occurredAt: UtcTimestamp,
  payload: Schema.Struct({
    userMessageId: Identity,
    agentRunId: Identity,
    content: Schema.Array(TextBlockSchema).pipe(Schema.check(Schema.isMinLength(1))),
  }),
});

export type UserMessageAppended = typeof UserMessageAppendedSchema.Type;

export interface UserMessageAppendedInput {
  readonly eventId: string;
  readonly threadId: string;
  readonly threadPosition: string;
  readonly occurredAt: string;
  readonly userMessageId: string;
  readonly agentRunId: string;
  readonly content: string;
}

export class InvalidUserMessageAppended extends Data.TaggedError("InvalidUserMessageAppended")<{
  readonly cause: unknown;
}> {}

export const makeUserMessageAppended = (input: UserMessageAppendedInput) =>
  Schema.decodeUnknownEffect(UserMessageAppendedSchema)({
    eventId: input.eventId,
    eventType: "UserMessageAppended",
    eventVersion: 1,
    threadId: input.threadId,
    threadPosition: input.threadPosition,
    occurredAt: input.occurredAt,
    payload: {
      userMessageId: input.userMessageId,
      agentRunId: input.agentRunId,
      content: [{ type: "text", text: input.content }],
    },
  }).pipe(Effect.mapError((cause) => new InvalidUserMessageAppended({ cause })));

export const ThreadEventEnvelopeSchema = Schema.Struct({
  eventId: Identity,
  eventType: Schema.Literal("UserMessageAppended"),
  eventVersion: Schema.Literal(1),
  threadId: Identity,
  threadPosition: ThreadPosition,
  occurredAt: UtcTimestamp,
  cursor: ThreadCursor,
  payload: Schema.Struct({
    userMessageId: Identity,
    agentRunId: Identity,
    content: Schema.Array(TextBlockSchema).pipe(Schema.check(Schema.isMinLength(1))),
  }),
});

export type ThreadEventEnvelope = typeof ThreadEventEnvelopeSchema.Type;

export const SourcePointSchema = Schema.Struct({
  eventId: Identity,
  position: ThreadPosition,
  occurredAt: UtcTimestamp,
});

export const SourceRangeSchema = Schema.Struct({
  firstEventId: Identity,
  firstPosition: ThreadPosition,
  firstOccurredAt: UtcTimestamp,
  lastEventId: Identity,
  lastPosition: ThreadPosition,
  lastOccurredAt: UtcTimestamp,
});

export const UserMessageTimelineItemSchema = Schema.Struct({
  type: Schema.Literal("userMessage"),
  userMessageId: Identity,
  agentRunId: Identity,
  source: SourceRangeSchema,
  content: Schema.Array(TextBlockSchema).pipe(Schema.check(Schema.isMinLength(1))),
});

export const ActiveAgentRunSchema = Schema.Struct({
  type: Schema.Literal("activeAgentRun"),
  agentRunId: Identity,
  introducedBy: SourcePointSchema,
  phase: Schema.Struct({ type: Schema.Literals(["pending", "running", "waiting"]) }),
});

const NonNegativePosition = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d+$/u)));

export const ThreadSnapshotSchema = Schema.Struct({
  projection: Schema.Literal("nativeThread"),
  schemaVersion: Schema.Literal(1),
  threadId: Identity,
  throughPosition: NonNegativePosition,
  throughCursor: ThreadCursor,
  stateRevision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  replayGuaranteedForMs: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  timelineLimit: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  historyBeforePosition: NonNegativePosition,
  timeline: Schema.Array(UserMessageTimelineItemSchema),
  activeState: Schema.Array(ActiveAgentRunSchema),
});

export type ThreadSnapshot = typeof ThreadSnapshotSchema.Type;

export class InvalidThreadSnapshot extends Data.TaggedError("InvalidThreadSnapshot")<{
  readonly cause: unknown;
}> {}

export class InvalidThreadProjection extends Data.TaggedError("InvalidThreadProjection")<{
  readonly reason: "authorityConflict" | "gap" | "wrongThread";
}> {}

export interface EmptyThreadSnapshotInput {
  readonly threadId: string;
  readonly throughCursor: string;
  readonly replayGuaranteedForMs?: number;
  readonly timelineLimit?: number;
}

export const makeEmptyThreadSnapshot = (input: EmptyThreadSnapshotInput) =>
  Schema.decodeUnknownEffect(ThreadSnapshotSchema)({
    projection: "nativeThread",
    schemaVersion: 1,
    threadId: input.threadId,
    throughPosition: "0",
    throughCursor: input.throughCursor,
    stateRevision: 0,
    replayGuaranteedForMs: input.replayGuaranteedForMs ?? 30_000,
    timelineLimit: input.timelineLimit ?? 100,
    historyBeforePosition: "0",
    timeline: [],
    activeState: [],
  }).pipe(Effect.mapError((cause) => new InvalidThreadSnapshot({ cause })));

const matchesProjectedEvent = (snapshot: ThreadSnapshot, event: ThreadEventEnvelope) => {
  const item = snapshot.timeline.find(
    (candidate) => candidate.source.firstPosition === event.threadPosition,
  );
  return (
    item?.source.firstEventId === event.eventId &&
    item.userMessageId === event.payload.userMessageId &&
    item.agentRunId === event.payload.agentRunId &&
    JSON.stringify(item.content) === JSON.stringify(event.payload.content)
  );
};

export const applyThreadEvent = (
  snapshot: ThreadSnapshot,
  event: ThreadEventEnvelope,
): Effect.Effect<ThreadSnapshot, InvalidThreadProjection> => {
  if (snapshot.threadId !== event.threadId) {
    return Effect.fail(new InvalidThreadProjection({ reason: "wrongThread" }));
  }

  const currentPosition = BigInt(snapshot.throughPosition);
  const eventPosition = BigInt(event.threadPosition);
  if (eventPosition < currentPosition) return Effect.succeed(snapshot);
  if (eventPosition === currentPosition) {
    return matchesProjectedEvent(snapshot, event)
      ? Effect.succeed(snapshot)
      : Effect.fail(new InvalidThreadProjection({ reason: "authorityConflict" }));
  }
  if (eventPosition !== currentPosition + 1n) {
    return Effect.fail(new InvalidThreadProjection({ reason: "gap" }));
  }

  const sourcePoint = {
    eventId: event.eventId,
    position: event.threadPosition,
    occurredAt: event.occurredAt,
  } as const;
  const sourceRange = {
    firstEventId: event.eventId,
    firstPosition: event.threadPosition,
    firstOccurredAt: event.occurredAt,
    lastEventId: event.eventId,
    lastPosition: event.threadPosition,
    lastOccurredAt: event.occurredAt,
  } as const;
  const timeline = [
    ...snapshot.timeline,
    {
      type: "userMessage" as const,
      userMessageId: event.payload.userMessageId,
      agentRunId: event.payload.agentRunId,
      source: sourceRange,
      content: event.payload.content,
    },
  ].slice(-snapshot.timelineLimit);

  return Effect.succeed({
    ...snapshot,
    throughPosition: event.threadPosition,
    throughCursor: event.cursor,
    stateRevision: snapshot.stateRevision + 1,
    historyBeforePosition: String(BigInt(timeline[0]!.source.firstPosition) - 1n),
    timeline,
    activeState: [
      ...snapshot.activeState,
      {
        type: "activeAgentRun",
        agentRunId: event.payload.agentRunId,
        introducedBy: sourcePoint,
        phase: { type: "pending" },
      },
    ],
  });
};
