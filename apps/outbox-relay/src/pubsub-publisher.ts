import {
  encodeRunnableDeliveryData,
  RunnableDeliveryPublisher,
  RunnableDeliveryPublisherUnavailable,
} from "@osfo/agent-run";
import { Data, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const NonEmptyText = Schema.String.check(Schema.isNonEmpty());

export const GooglePubSubPublisherConfigSchema = Schema.Struct({
  projectId: NonEmptyText,
  requestTimeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  topicId: NonEmptyText,
});

export type GooglePubSubPublisherConfig = typeof GooglePubSubPublisherConfigSchema.Type;

export class InvalidGooglePubSubPublisherConfig extends Data.TaggedError(
  "InvalidGooglePubSubPublisherConfig",
)<{ readonly cause: unknown }> {}

const AccessTokenResponseSchema = Schema.Struct({
  access_token: NonEmptyText,
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
  token_type: Schema.Literal("Bearer"),
});

const PublishResponseSchema = Schema.Struct({
  messageIds: Schema.Array(NonEmptyText).check(Schema.isMinLength(1)),
});

const metadataTokenUrl =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

const publisherLayer = (config: GooglePubSubPublisherConfig) =>
  Layer.effect(
    RunnableDeliveryPublisher,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const withRequestTimeout = <A, E>(
        operation: "publication" | "publish" | "token",
        effect: Effect.Effect<A, E>,
      ) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration: config.requestTimeoutMs,
            orElse: () =>
              Effect.fail(
                new RunnableDeliveryPublisherUnavailable({
                  cause: `${operation} request exceeded ${config.requestTimeoutMs} ms`,
                }),
              ),
          }),
          Effect.mapError((cause) =>
            cause instanceof RunnableDeliveryPublisherUnavailable
              ? cause
              : new RunnableDeliveryPublisherUnavailable({ cause }),
          ),
        );
      const fetchAccessToken = withRequestTimeout(
        "token",
        HttpClientRequest.get(metadataTokenUrl).pipe(
          HttpClientRequest.setHeader("metadata-flavor", "Google"),
          client.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(AccessTokenResponseSchema)),
        ),
      );
      let cachedToken:
        | { readonly refreshAfterMs: number; readonly value: typeof AccessTokenResponseSchema.Type }
        | undefined;
      const accessToken = Effect.suspend(() => {
        if (cachedToken !== undefined && Date.now() < cachedToken.refreshAfterMs) {
          return Effect.succeed(cachedToken.value);
        }
        return fetchAccessToken.pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              const lifetimeMs = value.expires_in * 1_000;
              cachedToken = {
                refreshAfterMs:
                  Date.now() + Math.max(1, lifetimeMs - Math.min(60_000, lifetimeMs / 2)),
                value,
              };
            }),
          ),
        );
      });
      const publishUrl = `https://pubsub.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/topics/${encodeURIComponent(config.topicId)}:publish`;

      const publishRequest = Effect.fn("GooglePubSubPublisher.publishRequest")(
        function* (delivery) {
          const token = yield* accessToken;
          const request = yield* HttpClientRequest.post(publishUrl).pipe(
            HttpClientRequest.bearerToken(token.access_token),
            HttpClientRequest.bodyJson({
              messages: [
                {
                  data: encodeRunnableDeliveryData(delivery),
                  attributes: { executionProfileRef: delivery.executionProfileRef },
                  orderingKey: delivery.threadId,
                },
              ],
            }),
            Effect.mapError((cause) => new RunnableDeliveryPublisherUnavailable({ cause })),
          );
          const response = yield* withRequestTimeout(
            "publish",
            client
              .execute(request)
              .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(PublishResponseSchema))),
          );
          const providerMessageId = response.messageIds[0];
          if (providerMessageId === undefined) {
            return yield* new RunnableDeliveryPublisherUnavailable({
              cause: "Pub/Sub confirmation omitted the provider message identity",
            });
          }
          return { providerMessageId };
        },
      );
      const publish = Effect.fn("GooglePubSubPublisher.publish")((delivery) =>
        withRequestTimeout("publication", publishRequest(delivery)),
      );

      return RunnableDeliveryPublisher.of({ publish });
    }),
  );

export const makeGooglePubSubPublisherLayer = (config: GooglePubSubPublisherConfig) =>
  Layer.unwrap(
    Schema.decodeUnknownEffect(GooglePubSubPublisherConfigSchema)(config).pipe(
      Effect.mapError((cause) => new InvalidGooglePubSubPublisherConfig({ cause })),
      Effect.map(publisherLayer),
    ),
  );
