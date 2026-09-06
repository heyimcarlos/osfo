import type { MessengerContext } from "@cloudflare/think/messengers";
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { Array, Effect, Option, Predicate, Schema, SchemaGetter } from "effect";

import type { ManagedTurnMetadata } from "../../domain/managed-conversation";
import type { ThinkSubmissionId } from "../../domain";
import { MessengerFileIngress } from "./messenger-file-ingress";

// Think includes optional attachment keys with undefined; retained JSON must omit them.
const retainedOptional = <S extends Schema.Top>(schema: S) =>
  Schema.optional(schema).pipe(
    Schema.decodeTo(Schema.optionalKey(Schema.toType(schema)), {
      decode: SchemaGetter.transformOptional((value) =>
        Option.filter(value, Predicate.isNotUndefined),
      ),
      encode: SchemaGetter.passthrough(),
    }),
  );

const retainedMessenger = Schema.StructWithRest(
  Schema.Struct({
    messenger: Schema.Struct({
      capabilities: Schema.Struct({}),
      kind: Schema.Literals(["direct-message", "mention", "subscribed-message"]),
      messengerId: Schema.String,
      provider: Schema.Literals(["telegram", "whatsapp"]),
      thread: Schema.Struct({
        id: Schema.String,
        providerThreadId: Schema.String,
        isDirectMessage: Schema.Boolean,
      }),
      message: Schema.Struct({
        id: Schema.String,
        providerMessageId: Schema.String,
        author: Schema.Struct({ userId: Schema.String }),
        text: Schema.String,
        attachments: Schema.Array(
          Schema.Struct({
            mediaType: retainedOptional(Schema.String),
            size: retainedOptional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
            fetchMetadata: retainedOptional(Schema.Record(Schema.String, Schema.String)),
          }),
        ),
      }),
    }),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export class Unavailable extends Schema.TaggedError<Unavailable>()("MessengerFileTurnUnavailable", {
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

/** Give legacy messenger chat the same server-owned identity as native submitted input. */
export const messageForSubmission = (
  userMessage: string | UIMessage,
  context: MessengerContext,
  submissionId: ThinkSubmissionId,
): UIMessage => ({
  ...(Predicate.isString(userMessage)
    ? { role: "user" as const, parts: [{ type: "text" as const, text: userMessage }] }
    : userMessage),
  id: submissionId,
  metadata: { messenger: context },
});

/** The latest User message remains current during assistant/tool continuations. */
export const currentUserMessage = (messages: ReadonlyArray<UIMessage>) =>
  Option.getOrUndefined(Array.findLast(messages, (message) => message.role === "user"));

/** Replace only the admitted User message; keep Think's repaired and truncated history intact. */
export const prepare = Effect.fn("MessengerFileTurn.prepare")(function* <
  AuthorizationError,
  UploadError,
  ReadError,
  PersistError,
>(
  input: {
    readonly metadata: Pick<ManagedTurnMetadata, "authorityIdentity" | "submissionId">;
    readonly messages: ReadonlyArray<UIMessage>;
    readonly modelMessages: globalThis.Array<ModelMessage>;
  },
  dependencies: MessengerFileIngress.Dependencies<AuthorizationError, UploadError, ReadError> & {
    readonly persist: (message: UIMessage) => Effect.Effect<void, PersistError>;
  },
) {
  const authority = input.metadata.authorityIdentity;
  if (!Predicate.isTagged(authority, "ChannelLink")) return input.modelMessages;
  const source = currentUserMessage(input.messages);
  // Only a native submission owns this identity. Unrelated turns must not reprocess old media.
  if (source === undefined || source.id !== input.metadata.submissionId) return input.modelMessages;
  const retained = yield* Schema.decodeUnknownEffect(retainedMessenger)(source.metadata).pipe(
    Effect.mapError(unavailable),
  );
  const context = {
    ...retained.messenger,
    message: {
      ...retained.messenger.message,
      attachments: [...retained.messenger.message.attachments],
    },
  };
  if (
    context.messengerId !== authority.address.channelId ||
    context.message.author.userId !== authority.address.authorId
  )
    return yield* unavailable("The retained attachment belongs to a different channel authority");
  const hasAttachments = context.message.attachments.length > 0;
  const currentUserIndex = input.modelMessages.reduce(
    (last, message, index) => (message.role === "user" ? index : last),
    -1,
  );
  if (currentUserIndex < 0) return yield* unavailable("The admitted User message is absent");
  const prepared = hasAttachments
    ? yield* MessengerFileIngress.ingest(
        {
          context,
          submissionId: input.metadata.submissionId,
          userId: authority.userId,
          // Retained provider text prevents duplicate result annotations after an interrupted turn.
          userMessage: {
            ...source,
            // Live SDK contexts contain Dates and callbacks. Retain only the decoded messenger
            // snapshot so capability stamping can preserve it through interruptions.
            metadata: retained,
            parts: [{ type: "text", text: MessengerFileIngress.admissionText(context) }],
          },
        },
        dependencies,
      )
    : { ...source, metadata: retained };
  if (Predicate.isString(prepared)) return yield* unavailable("Expected a native User message");
  if (!(yield* dependencies.authorize))
    return yield* unavailable("Current file authority was revoked");
  yield* dependencies.persist(prepared);
  if (!hasAttachments) return input.modelMessages;
  const replacement = yield* Effect.tryPromise({
    try: () => convertToModelMessages([prepared]),
    catch: unavailable,
  });
  return [
    ...input.modelMessages.slice(0, currentUserIndex),
    ...replacement,
    ...input.modelMessages.slice(currentUserIndex + 1),
  ];
});

const unavailable = (cause: unknown) =>
  new Unavailable({
    cause,
    message: "The admitted attachment could not be prepared for this turn",
  });

export * as MessengerFileTurn from "./messenger-file-turn";
