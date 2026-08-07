import { RunnableDeliveryPublisher } from "@osfo/agent-run";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Ref } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { makeGooglePubSubPublisherLayer } from "../src/pubsub-publisher.js";

describe("Google Pub/Sub runnable delivery publisher", () => {
  it.effect("returns provider confirmation evidence through Effect HTTP", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]);
      const http = HttpClient.make((request) =>
        Ref.update(requests, (current) => [...current, request]).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              request.url.includes("metadata.google.internal")
                ? new Response(
                    JSON.stringify({
                      access_token: "metadata-access-token",
                      expires_in: 3_600,
                      token_type: "Bearer",
                    }),
                    { status: 200 },
                  )
                : new Response(JSON.stringify({ messageIds: ["provider-message-1"] }), {
                    status: 200,
                  }),
            ),
          ),
        ),
      );
      const confirmation = yield* RunnableDeliveryPublisher.use((publisher) =>
        publisher.publish({
          version: 1,
          deliveryId: "b1dfd21a-7526-4e52-a732-8e01debd1d52",
          agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
          threadId: "512e5093-0051-4f82-b452-78d907ead08c",
          executionProfileRef: "oz.deterministic.v1",
        }),
      ).pipe(
        Effect.provide(
          makeGooglePubSubPublisherLayer({
            projectId: "osfo-test",
            requestTimeoutMs: 1_000,
            topicId: "agent-runs",
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, http),
      );

      expect(confirmation).toEqual({ providerMessageId: "provider-message-1" });
      const observed = yield* Ref.get(requests);
      expect(observed.map((request) => request.url)).toEqual([
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        "https://pubsub.googleapis.com/v1/projects/osfo-test/topics/agent-runs:publish",
      ]);
      expect(observed[1]?.headers.authorization).toBe("Bearer metadata-access-token");
      const publishRequest = observed[1];
      expect(publishRequest).toBeDefined();
      const publishBody = yield* HttpClientRequest.toWeb(publishRequest!).pipe(
        Effect.flatMap((request) => Effect.promise(() => request.json())),
      );
      expect(publishBody).toMatchObject({
        messages: [
          {
            attributes: { executionProfileRef: "oz.deterministic.v1" },
            orderingKey: "512e5093-0051-4f82-b452-78d907ead08c",
          },
        ],
      });
    }),
  );

  it.effect("does not cache a failed access-token request", () =>
    Effect.gen(function* () {
      let tokenRequests = 0;
      const http = HttpClient.make((request) => {
        if (request.url.includes("metadata.google.internal")) {
          tokenRequests += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              tokenRequests === 1
                ? new Response("unavailable", { status: 503 })
                : new Response(
                    JSON.stringify({
                      access_token: "recovered-token",
                      expires_in: 3_600,
                      token_type: "Bearer",
                    }),
                    { status: 200 },
                  ),
            ),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ messageIds: ["provider-message-2"] }), { status: 200 }),
          ),
        );
      });
      const delivery = {
        version: 1,
        deliveryId: "b1dfd21a-7526-4e52-a732-8e01debd1d52",
        agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
        threadId: "512e5093-0051-4f82-b452-78d907ead08c",
        executionProfileRef: "oz.deterministic.v1",
      } as const;
      const [first, second] = yield* RunnableDeliveryPublisher.use((publisher) =>
        Effect.gen(function* () {
          const failed = yield* Effect.exit(publisher.publish(delivery));
          const recovered = yield* publisher.publish(delivery);
          return [failed, recovered] as const;
        }),
      ).pipe(
        Effect.provide(
          makeGooglePubSubPublisherLayer({
            projectId: "osfo-test",
            requestTimeoutMs: 1_000,
            topicId: "agent-runs",
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, http),
      );

      expect(Exit.isFailure(first)).toBe(true);
      expect(second).toEqual({ providerMessageId: "provider-message-2" });
      expect(tokenRequests).toBe(2);
    }),
  );

  it.live("bounds token and publish HTTP by the publication lease budget", () =>
    Effect.gen(function* () {
      const http = HttpClient.make(() => Effect.never);
      const result = yield* RunnableDeliveryPublisher.use((publisher) =>
        Effect.exit(
          publisher.publish({
            version: 1,
            deliveryId: "b1dfd21a-7526-4e52-a732-8e01debd1d52",
            agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
            threadId: "512e5093-0051-4f82-b452-78d907ead08c",
            executionProfileRef: "oz.deterministic.v1",
          }),
        ),
      ).pipe(
        Effect.provide(
          makeGooglePubSubPublisherLayer({
            projectId: "osfo-test",
            requestTimeoutMs: 10,
            topicId: "agent-runs",
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.die("publisher exceeded its configured request timeout"),
        }),
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
});
