import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { Effect, Schema } from "effect";

import type { ManagedTurnMetadata } from "../../domain/managed-conversation";
import { MessengerFileIngress } from "./messenger-file-ingress";

const retainedMessenger = Schema.Struct({
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
          mediaType: Schema.optionalKey(Schema.String),
          size: Schema.optionalKey(Schema.Number),
          fetchMetadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
        }),
      ),
    }),
  }),
});

export class Unavailable extends Schema.TaggedError<Unavailable>()("MessengerFileTurnUnavailable", {
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

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
    readonly modelMessages: Array<ModelMessage>;
  },
  dependencies: MessengerFileIngress.Dependencies<AuthorizationError, UploadError, ReadError> & {
    readonly persist: (message: UIMessage) => Effect.Effect<void, PersistError>;
  },
) {
  const authority = input.metadata.authorityIdentity;
  if (authority._tag !== "ChannelLink") return input.modelMessages;
  const source = input.messages.filter((message) => message.role === "user").at(-1);
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
  if (context.message.attachments.length === 0) return input.modelMessages;
  const currentUserIndex = input.modelMessages.reduce(
    (last, message, index) => (message.role === "user" ? index : last),
    -1,
  );
  if (currentUserIndex < 0) return yield* unavailable("The admitted User message is absent");
  const prepared = yield* MessengerFileIngress.ingest(
    {
      context,
      submissionId: input.metadata.submissionId,
      userId: authority.userId,
      // Retained provider text prevents duplicate result annotations after an interrupted turn.
      userMessage: {
        ...source,
        parts: [{ type: "text", text: MessengerFileIngress.admissionText(context) }],
      },
    },
    dependencies,
  );
  if (typeof prepared === "string") return yield* unavailable("Expected a native User message");
  if (!(yield* dependencies.authorize))
    return yield* unavailable("Current file authority was revoked");
  yield* dependencies.persist(prepared);
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
