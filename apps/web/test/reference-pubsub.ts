import { StreamingPullSource, type StreamingPullHandlers } from "@osfo/agent-run-worker";
import { Data, Deferred, Effect, Schema } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

const PublishRequestSchema = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      attributes: Schema.Struct({ executionProfileRef: Schema.NonEmptyString }),
      data: Schema.NonEmptyString,
      orderingKey: Schema.NonEmptyString,
    }),
  ).check(Schema.isMinLength(1)),
});

export class ReferencePubSubBoundaryError extends Data.TaggedError("ReferencePubSubBoundaryError")<{
  readonly operation: string;
  readonly cause?: unknown;
}> {}

interface Publication {
  readonly acknowledged: Deferred.Deferred<void>;
  readonly data: string;
  readonly nacked: Deferred.Deferred<void>;
  readonly orderingKey: string;
  readonly providerMessageId: string;
}

const waitForPublication = (publications: ReadonlyArray<Publication>, index: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const publication = publications[index];
      if (publication !== undefined) return publication;
      yield* Effect.sleep(25);
    }
    return yield* new ReferencePubSubBoundaryError({
      operation: `wait for Pub/Sub publication ${index + 1}`,
    });
  });

export const makeReferencePubSubBoundary = Effect.gen(function* () {
  const sourceStarted = yield* Deferred.make<void>();
  const publications: Array<Publication> = [];
  let handlers: StreamingPullHandlers | undefined;

  const source = StreamingPullSource.of({
    start: (nextHandlers) =>
      Effect.sync(() => {
        handlers = nextHandlers;
        Deferred.doneUnsafe(sourceStarted, Effect.void);
      }),
    stop: () => Effect.void,
    close: () => Effect.void,
  });

  const httpClient = HttpClient.make((request, _url, signal) => {
    if (request.url.includes("metadata.google.internal")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              access_token: "reference-metadata-token",
              expires_in: 3_600,
              token_type: "Bearer",
            }),
            { status: 200 },
          ),
        ),
      );
    }

    return HttpClientRequest.toWeb(request, { signal }).pipe(
      Effect.flatMap((webRequest) =>
        Effect.tryPromise({
          try: () => webRequest.json(),
          catch: (cause) =>
            new ReferencePubSubBoundaryError({ operation: "read Pub/Sub publish body", cause }),
        }),
      ),
      Effect.flatMap(Schema.decodeUnknownEffect(PublishRequestSchema)),
      Effect.flatMap((body) =>
        Effect.gen(function* () {
          const activeHandlers = handlers;
          if (activeHandlers === undefined) {
            return yield* new ReferencePubSubBoundaryError({
              operation: "deliver before StreamingPull subscriber started",
            });
          }
          return yield* Effect.sync(() => {
            const messageIds = body.messages.map((message) => {
              const providerMessageId = `reference-pubsub-${publications.length + 1}`;
              const acknowledged = Deferred.makeUnsafe<void>();
              const nacked = Deferred.makeUnsafe<void>();
              publications.push({
                acknowledged,
                data: message.data,
                nacked,
                orderingKey: message.orderingKey,
                providerMessageId,
              });
              activeHandlers.onMessage({
                acknowledge: () => Deferred.doneUnsafe(acknowledged, Effect.void),
                data: Buffer.from(message.data, "base64"),
                id: providerMessageId,
                nack: () => Deferred.doneUnsafe(nacked, Effect.void),
                orderingKey: message.orderingKey,
              });
              return providerMessageId;
            });
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ messageIds }), { status: 200 }),
            );
          });
        }),
      ),
      Effect.mapError(
        (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.EncodeError({
              request,
              cause: new ReferencePubSubBoundaryError({
                operation: "publish through reference Pub/Sub",
                cause,
              }),
            }),
          }),
      ),
    );
  });

  const waitForSettlement = (index: number) =>
    waitForPublication(publications, index).pipe(
      Effect.flatMap((publication) =>
        Effect.raceFirst(
          Deferred.await(publication.acknowledged).pipe(Effect.as("acknowledged" as const)),
          Deferred.await(publication.nacked).pipe(Effect.as("nacked" as const)),
        ),
      ),
    );

  return {
    httpClient,
    publications,
    source,
    sourceStarted: Deferred.await(sourceStarted),
    waitForSettlement,
  };
});
