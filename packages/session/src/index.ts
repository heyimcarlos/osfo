import * as Schema from "effect/Schema";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const Identity = Schema.String.pipe(Schema.check(Schema.isPattern(uuidPattern)));
const ThreadPosition = Schema.String.pipe(Schema.check(Schema.isPattern(/^[1-9]\d*$/u)));
const UtcTimestamp = Schema.String.pipe(Schema.check(Schema.isPattern(utcTimestampPattern)));

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
}

const decodeUserMessageAppended = Schema.decodeUnknownSync(UserMessageAppendedSchema);

export const makeUserMessageAppended = (input: UserMessageAppendedInput): UserMessageAppended => {
  try {
    return decodeUserMessageAppended({
      eventId: input.eventId,
      eventType: "UserMessageAppended",
      eventVersion: 1,
      threadId: input.threadId,
      threadPosition: input.threadPosition,
      occurredAt: input.occurredAt,
      payload: {
        userMessageId: input.userMessageId,
        agentRunId: input.agentRunId,
      },
    });
  } catch (cause) {
    throw new Error("Invalid UserMessageAppended", { cause });
  }
};
