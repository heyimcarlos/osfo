import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const Identity = Schema.String.pipe(Schema.check(Schema.isPattern(uuidPattern)));
const ThreadPosition = Schema.String.pipe(Schema.check(Schema.isPattern(/^[1-9]\d*$/u)));
const UtcTimestamp = Schema.String.pipe(Schema.check(Schema.isPattern(utcTimestampPattern)));
const ThreadCursor = Schema.String.pipe(Schema.check(Schema.isNonEmpty()));
const ModelCallFailureCause = Schema.Literal("modelCallFailed");

export const TextBlockSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String.pipe(
    Schema.check(Schema.isNonEmpty()),
    Schema.check(Schema.isMaxLength(16_384)),
  ),
});

export type TextBlock = typeof TextBlockSchema.Type;

const eventFields = {
  eventId: Identity,
  eventVersion: Schema.Literal(1),
  threadId: Identity,
  threadPosition: ThreadPosition,
  occurredAt: UtcTimestamp,
};

export const UserMessageAppendedSchema = Schema.Struct({
  ...eventFields,
  eventType: Schema.Literal("UserMessageAppended"),
  payload: Schema.Struct({
    userMessageId: Identity,
    agentRunId: Identity,
    content: Schema.Array(TextBlockSchema).pipe(Schema.check(Schema.isMinLength(1))),
  }),
});

export const AssistantOutputAppendedSchema = Schema.Struct({
  ...eventFields,
  eventType: Schema.Literal("AssistantOutputAppended"),
  payload: Schema.Struct({
    assistantOutputId: Identity,
    agentRunId: Identity,
    content: Schema.Array(TextBlockSchema).pipe(Schema.check(Schema.isMinLength(1))),
  }),
});

export const AssistantOutputCompletedSchema = Schema.Struct({
  ...eventFields,
  eventType: Schema.Literal("AssistantOutputCompleted"),
  payload: Schema.Struct({ assistantOutputId: Identity, agentRunId: Identity }),
});

export const AssistantOutputInterruptedSchema = Schema.Struct({
  ...eventFields,
  eventType: Schema.Literal("AssistantOutputInterrupted"),
  payload: Schema.Struct({
    assistantOutputId: Identity,
    agentRunId: Identity,
    cause: ModelCallFailureCause,
  }),
});

export const AgentRunSucceededSchema = Schema.Struct({
  ...eventFields,
  eventType: Schema.Literal("AgentRunSucceeded"),
  payload: Schema.Struct({ agentRunId: Identity }),
});

export const AgentRunFailedSchema = Schema.Struct({
  ...eventFields,
  eventType: Schema.Literal("AgentRunFailed"),
  payload: Schema.Struct({ agentRunId: Identity, cause: ModelCallFailureCause }),
});

export const ThreadEventSchema = Schema.Union([
  UserMessageAppendedSchema,
  AssistantOutputAppendedSchema,
  AssistantOutputCompletedSchema,
  AssistantOutputInterruptedSchema,
  AgentRunSucceededSchema,
  AgentRunFailedSchema,
]);

export type UserMessageAppended = typeof UserMessageAppendedSchema.Type;
export type AssistantOutputAppended = typeof AssistantOutputAppendedSchema.Type;
export type AssistantOutputCompleted = typeof AssistantOutputCompletedSchema.Type;
export type AssistantOutputInterrupted = typeof AssistantOutputInterruptedSchema.Type;
export type AgentRunSucceeded = typeof AgentRunSucceededSchema.Type;
export type AgentRunFailed = typeof AgentRunFailedSchema.Type;
export type ThreadEvent = typeof ThreadEventSchema.Type;

export interface UserMessageAppendedInput {
  readonly eventId: string;
  readonly threadId: string;
  readonly threadPosition: string;
  readonly occurredAt: string;
  readonly userMessageId: string;
  readonly agentRunId: string;
  readonly content: string;
}

interface AgentRunEventInput {
  readonly eventId: string;
  readonly threadId: string;
  readonly threadPosition: string;
  readonly occurredAt: string;
  readonly agentRunId: string;
}

interface AssistantOutputEventInput extends AgentRunEventInput {
  readonly assistantOutputId: string;
}

export interface AssistantOutputAppendedInput extends AssistantOutputEventInput {
  readonly content: string;
}

export interface AssistantOutputInterruptedInput extends AssistantOutputEventInput {
  readonly cause: "modelCallFailed";
}

export interface AgentRunFailedInput extends AgentRunEventInput {
  readonly cause: "modelCallFailed";
}

export class InvalidUserMessageAppended extends Data.TaggedError("InvalidUserMessageAppended")<{
  readonly cause: unknown;
}> {}

export class InvalidThreadEvent extends Data.TaggedError("InvalidThreadEvent")<{
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

export const makeAssistantOutputAppended = (input: AssistantOutputAppendedInput) =>
  Schema.decodeUnknownEffect(AssistantOutputAppendedSchema)({
    eventId: input.eventId,
    eventType: "AssistantOutputAppended",
    eventVersion: 1,
    threadId: input.threadId,
    threadPosition: input.threadPosition,
    occurredAt: input.occurredAt,
    payload: {
      assistantOutputId: input.assistantOutputId,
      agentRunId: input.agentRunId,
      content: [{ type: "text", text: input.content }],
    },
  }).pipe(Effect.mapError((cause) => new InvalidThreadEvent({ cause })));

export const makeAssistantOutputCompleted = (input: AssistantOutputEventInput) =>
  Schema.decodeUnknownEffect(AssistantOutputCompletedSchema)({
    eventId: input.eventId,
    eventType: "AssistantOutputCompleted",
    eventVersion: 1,
    threadId: input.threadId,
    threadPosition: input.threadPosition,
    occurredAt: input.occurredAt,
    payload: {
      assistantOutputId: input.assistantOutputId,
      agentRunId: input.agentRunId,
    },
  }).pipe(Effect.mapError((cause) => new InvalidThreadEvent({ cause })));

export const makeAssistantOutputInterrupted = (input: AssistantOutputInterruptedInput) =>
  Schema.decodeUnknownEffect(AssistantOutputInterruptedSchema)({
    eventId: input.eventId,
    eventType: "AssistantOutputInterrupted",
    eventVersion: 1,
    threadId: input.threadId,
    threadPosition: input.threadPosition,
    occurredAt: input.occurredAt,
    payload: {
      assistantOutputId: input.assistantOutputId,
      agentRunId: input.agentRunId,
      cause: input.cause,
    },
  }).pipe(Effect.mapError((cause) => new InvalidThreadEvent({ cause })));

export const makeAgentRunSucceeded = (input: AgentRunEventInput) =>
  Schema.decodeUnknownEffect(AgentRunSucceededSchema)({
    eventId: input.eventId,
    eventType: "AgentRunSucceeded",
    eventVersion: 1,
    threadId: input.threadId,
    threadPosition: input.threadPosition,
    occurredAt: input.occurredAt,
    payload: { agentRunId: input.agentRunId },
  }).pipe(Effect.mapError((cause) => new InvalidThreadEvent({ cause })));

export const makeAgentRunFailed = (input: AgentRunFailedInput) =>
  Schema.decodeUnknownEffect(AgentRunFailedSchema)({
    eventId: input.eventId,
    eventType: "AgentRunFailed",
    eventVersion: 1,
    threadId: input.threadId,
    threadPosition: input.threadPosition,
    occurredAt: input.occurredAt,
    payload: { agentRunId: input.agentRunId, cause: input.cause },
  }).pipe(Effect.mapError((cause) => new InvalidThreadEvent({ cause })));

const withCursor = <A extends Schema.Struct.Fields>(fields: A) =>
  Schema.Struct({ ...fields, cursor: ThreadCursor });

export const ThreadEventEnvelopeSchema = Schema.Union([
  withCursor(UserMessageAppendedSchema.fields),
  withCursor(AssistantOutputAppendedSchema.fields),
  withCursor(AssistantOutputCompletedSchema.fields),
  withCursor(AssistantOutputInterruptedSchema.fields),
  withCursor(AgentRunSucceededSchema.fields),
  withCursor(AgentRunFailedSchema.fields),
]);

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

export const AssistantOutputTimelineItemSchema = Schema.Struct({
  type: Schema.Literal("assistantOutput"),
  assistantOutputId: Identity,
  agentRunId: Identity,
  source: SourceRangeSchema,
  content: Schema.Array(TextBlockSchema),
  status: Schema.Union([
    Schema.Struct({ type: Schema.Literal("streaming") }),
    Schema.Struct({ type: Schema.Literal("completed") }),
    Schema.Struct({ type: Schema.Literal("interrupted"), cause: ModelCallFailureCause }),
  ]),
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
  schemaVersion: Schema.Literal(2),
  threadId: Identity,
  throughPosition: NonNegativePosition,
  throughCursor: ThreadCursor,
  lastEventId: Schema.NullOr(Identity),
  stateRevision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  replayGuaranteedForMs: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  timelineLimit: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  historyBeforePosition: NonNegativePosition,
  timeline: Schema.Array(
    Schema.Union([UserMessageTimelineItemSchema, AssistantOutputTimelineItemSchema]),
  ),
  activeState: Schema.Array(ActiveAgentRunSchema),
});

export type ThreadSnapshot = typeof ThreadSnapshotSchema.Type;
export type ThreadTimelineItem = ThreadSnapshot["timeline"][number];
type AssistantOutputTimelineItem = Extract<
  ThreadTimelineItem,
  { readonly type: "assistantOutput" }
>;

const isAssistantOutputTimelineItem = (
  item: ThreadTimelineItem,
): item is AssistantOutputTimelineItem => item.type === "assistantOutput";

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
    schemaVersion: 2,
    threadId: input.threadId,
    throughPosition: "0",
    throughCursor: input.throughCursor,
    lastEventId: null,
    stateRevision: 0,
    replayGuaranteedForMs: input.replayGuaranteedForMs ?? 30_000,
    timelineLimit: input.timelineLimit ?? 100,
    historyBeforePosition: "0",
    timeline: [],
    activeState: [],
  }).pipe(Effect.mapError((cause) => new InvalidThreadSnapshot({ cause })));

const sourcePoint = (event: ThreadEventEnvelope) => ({
  eventId: event.eventId,
  position: event.threadPosition,
  occurredAt: event.occurredAt,
});

const sourceRange = (event: ThreadEventEnvelope) => ({
  firstEventId: event.eventId,
  firstPosition: event.threadPosition,
  firstOccurredAt: event.occurredAt,
  lastEventId: event.eventId,
  lastPosition: event.threadPosition,
  lastOccurredAt: event.occurredAt,
});

const advanceSource = (source: ThreadTimelineItem["source"], event: ThreadEventEnvelope) => ({
  ...source,
  lastEventId: event.eventId,
  lastPosition: event.threadPosition,
  lastOccurredAt: event.occurredAt,
});

const failAuthorityConflict = () =>
  Effect.fail(new InvalidThreadProjection({ reason: "authorityConflict" }));

const applyNextEvent = Effect.fn("Session.applyNextThreadEvent")(function* (
  snapshot: ThreadSnapshot,
  event: ThreadEventEnvelope,
) {
  let timeline = snapshot.timeline;
  let activeState = snapshot.activeState;

  switch (event.eventType) {
    case "UserMessageAppended": {
      timeline = [
        ...timeline,
        {
          type: "userMessage" as const,
          userMessageId: event.payload.userMessageId,
          agentRunId: event.payload.agentRunId,
          source: sourceRange(event),
          content: event.payload.content,
        },
      ];
      activeState = [
        ...activeState,
        {
          type: "activeAgentRun" as const,
          agentRunId: event.payload.agentRunId,
          introducedBy: sourcePoint(event),
          phase: { type: "pending" as const },
        },
      ];
      break;
    }
    case "AssistantOutputAppended": {
      const existing = timeline.find(
        (item): item is AssistantOutputTimelineItem =>
          isAssistantOutputTimelineItem(item) &&
          item.assistantOutputId === event.payload.assistantOutputId,
      );
      if (existing !== undefined && existing.status.type !== "streaming") {
        return yield* failAuthorityConflict();
      }
      if (existing !== undefined && existing.agentRunId !== event.payload.agentRunId) {
        return yield* failAuthorityConflict();
      }
      timeline =
        existing === undefined
          ? [
              ...timeline,
              {
                type: "assistantOutput" as const,
                assistantOutputId: event.payload.assistantOutputId,
                agentRunId: event.payload.agentRunId,
                source: sourceRange(event),
                content: event.payload.content,
                status: { type: "streaming" as const },
              },
            ]
          : timeline.map((item) =>
              item === existing
                ? {
                    ...existing,
                    source: advanceSource(existing.source, event),
                    content: [...existing.content, ...event.payload.content],
                  }
                : item,
            );
      activeState = activeState.map((run) =>
        run.agentRunId === event.payload.agentRunId
          ? { ...run, phase: { type: "running" as const } }
          : run,
      );
      break;
    }
    case "AssistantOutputCompleted":
    case "AssistantOutputInterrupted": {
      const existing = timeline.find(
        (item): item is AssistantOutputTimelineItem =>
          isAssistantOutputTimelineItem(item) &&
          item.assistantOutputId === event.payload.assistantOutputId,
      );
      if (existing !== undefined && existing.status.type !== "streaming") {
        return yield* failAuthorityConflict();
      }
      if (existing !== undefined && existing.agentRunId !== event.payload.agentRunId) {
        return yield* failAuthorityConflict();
      }
      const status =
        event.eventType === "AssistantOutputCompleted"
          ? ({ type: "completed" } as const)
          : ({ type: "interrupted", cause: event.payload.cause } as const);
      timeline =
        existing === undefined
          ? [
              ...timeline,
              {
                type: "assistantOutput" as const,
                assistantOutputId: event.payload.assistantOutputId,
                agentRunId: event.payload.agentRunId,
                source: sourceRange(event),
                content: [],
                status,
              },
            ]
          : timeline.map((item) =>
              item === existing
                ? { ...existing, source: advanceSource(existing.source, event), status }
                : item,
            );
      activeState = activeState.map((run) =>
        run.agentRunId === event.payload.agentRunId
          ? { ...run, phase: { type: "running" as const } }
          : run,
      );
      break;
    }
    case "AgentRunSucceeded":
    case "AgentRunFailed": {
      const activeRun = activeState.find((run) => run.agentRunId === event.payload.agentRunId);
      if (activeRun === undefined) return yield* failAuthorityConflict();
      const openOutput = timeline.find(
        (item) =>
          item.type === "assistantOutput" &&
          item.agentRunId === event.payload.agentRunId &&
          item.status.type === "streaming",
      );
      if (openOutput !== undefined) return yield* failAuthorityConflict();
      activeState = activeState.filter((run) => run.agentRunId !== event.payload.agentRunId);
      break;
    }
  }

  const boundedTimeline = timeline.slice(-snapshot.timelineLimit);
  return {
    ...snapshot,
    throughPosition: event.threadPosition,
    throughCursor: event.cursor,
    lastEventId: event.eventId,
    stateRevision: snapshot.stateRevision + 1,
    historyBeforePosition:
      boundedTimeline[0] === undefined
        ? "0"
        : String(BigInt(boundedTimeline[0].source.firstPosition) - 1n),
    timeline: boundedTimeline,
    activeState,
  } satisfies ThreadSnapshot;
});

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
    return snapshot.lastEventId === event.eventId
      ? Effect.succeed(snapshot)
      : failAuthorityConflict();
  }
  if (eventPosition !== currentPosition + 1n) {
    return Effect.fail(new InvalidThreadProjection({ reason: "gap" }));
  }

  return applyNextEvent(snapshot, event);
};
