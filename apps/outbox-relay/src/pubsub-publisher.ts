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
      const fetchAccessToken = HttpClientRequest.get(metadataTokenUrl).pipe(
        HttpClientRequest.setHeader("metadata-flavor", "Google"),
        client.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(AccessTokenResponseSchema)),
        Effect.mapError((cause) => new RunnableDeliveryPublisherUnavailable({ cause })),
      );
      const accessToken = yield* Effect.cachedWithTTL(fetchAccessToken, "5 minutes");
      const publishUrl = `https://pubsub.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/topics/${encodeURIComponent(config.topicId)}:publish`;

      const publish = Effect.fn("GooglePubSubPublisher.publish")(function* (delivery) {
        const token = yield* accessToken;
        const request = yield* HttpClientRequest.post(publishUrl).pipe(
          HttpClientRequest.bearerToken(token.access_token),
          HttpClientRequest.bodyJson({
            messages: [
              {
                data: encodeRunnableDeliveryData(delivery),
                attributes: { executionProfileRef: delivery.executionProfileRef },
              },
            ],
          }),
          Effect.mapError((cause) => new RunnableDeliveryPublisherUnavailable({ cause })),
        );
        const response = yield* client.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(PublishResponseSchema)),
          Effect.mapError((cause) => new RunnableDeliveryPublisherUnavailable({ cause })),
        );
        const providerMessageId = response.messageIds[0];
        if (providerMessageId === undefined) {
          return yield* new RunnableDeliveryPublisherUnavailable({
            cause: "Pub/Sub confirmation omitted the provider message identity",
          });
        }
        return { providerMessageId };
      });

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
