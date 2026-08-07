import { AuthenticationRejected, ConnectionLimitExceeded, ThreadNotFound } from "@osfo/api";
import { getThreadSnapshot, streamThreadEvents, submitThreadMessage } from "@osfo/api/client";
import { prepareMessageAdmissionFixture, setAuthenticationSessionState } from "@osfo/db/testing";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { startCompiledIngress } from "../src/testing.js";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const authenticationToken = "thread-lifecycle-session";
const otherAuthenticationToken = "other-thread-lifecycle-session";
const otherPrincipalId = "76f4550a-5823-4b91-828d-e6ccae4b7e48";
const otherThreadId = "0421713c-3f3e-456d-8b72-4454b62d1c58";
const principalId = "2f383a92-f780-4c84-87b0-b2fbd72a34dd";
const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";

describe("compiled ingress Thread stream lifecycle", () => {
  it.live("enforces frozen stream admission and established-session behavior", () =>
    Effect.gen(function* () {
      yield* prepareMessageAdmissionFixture(databaseUrl, {
        principals: [
          { authenticationToken, principalId, threadIds: [threadId] },
          {
            authenticationToken: otherAuthenticationToken,
            principalId: otherPrincipalId,
            threadIds: [otherThreadId],
          },
        ],
      });
      const ingress = yield* startCompiledIngress({
        databaseUrl,
        maxStreamConnections: 1,
        streamPollIntervalMs: 10,
      });
      const clientOptions = {
        authenticationToken,
        baseUrl: ingress.origin,
      };
      const snapshot = yield* getThreadSnapshot({ ...clientOptions, threadId });

      const openObservedStream = Effect.gen(function* () {
        const caughtUp = yield* Deferred.make<void>();
        const stream = yield* streamThreadEvents({
          ...clientOptions,
          after: snapshot.throughCursor,
          threadId,
        });
        const fiber = yield* stream.pipe(
          Stream.tap((event) =>
            event.event === "caught_up"
              ? Deferred.succeed(caughtUp, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* Deferred.await(caughtUp).pipe(Effect.timeout("2 seconds"));
        return fiber;
      });

      const expiringStream = yield* openObservedStream;
      const atCapacity = yield* streamThreadEvents({
        ...clientOptions,
        after: snapshot.throughCursor,
        threadId,
      }).pipe(Effect.flip);
      expect(atCapacity).toEqual(new ConnectionLimitExceeded({ retryAfterSeconds: 5 }));

      const unknown = yield* getThreadSnapshot({
        ...clientOptions,
        threadId: crypto.randomUUID(),
      }).pipe(Effect.flip);
      const unauthorized = yield* getThreadSnapshot({
        ...clientOptions,
        threadId: otherThreadId,
      }).pipe(Effect.flip);
      expect(unknown).toEqual(new ThreadNotFound());
      expect(unauthorized).toEqual(new ThreadNotFound());

      const unauthorizedWhileFull = yield* streamThreadEvents({
        ...clientOptions,
        after: "not-a-disclosed-cursor",
        threadId: otherThreadId,
      }).pipe(Effect.flip);
      expect(unauthorizedWhileFull).toEqual(new ThreadNotFound());

      yield* setAuthenticationSessionState(databaseUrl, {
        authenticationToken,
        state: "expired",
      });
      yield* Fiber.join(expiringStream).pipe(Effect.timeout("2 seconds"));
      const expired = yield* getThreadSnapshot({ ...clientOptions, threadId }).pipe(Effect.flip);
      expect(expired).toEqual(new AuthenticationRejected());

      yield* setAuthenticationSessionState(databaseUrl, {
        authenticationToken,
        state: "active",
      });
      const revokedStream = yield* openObservedStream;
      yield* setAuthenticationSessionState(databaseUrl, {
        authenticationToken,
        state: "revoked",
      });
      yield* Fiber.join(revokedStream).pipe(Effect.timeout("2 seconds"));
      const revoked = yield* getThreadSnapshot({ ...clientOptions, threadId }).pipe(Effect.flip);
      expect(revoked).toEqual(new AuthenticationRejected());
    }),
  );

  it.live(
    "closes a slow HTTP client and replays every durable event from its cursor",
    () =>
      Effect.gen(function* () {
        yield* prepareMessageAdmissionFixture(databaseUrl, {
          principals: [{ authenticationToken, principalId, threadIds: [threadId] }],
        });
        const slowIngress = yield* startCompiledIngress({
          databaseUrl,
          globalNonTerminalLimit: 64,
          maxStreamBufferedAgeMs: 100,
          maxStreamBufferedBytes: 65_536,
          maxStreamBufferedEvents: 4,
          maxStreamConnections: 2,
          principalNonTerminalLimit: 64,
          streamPollIntervalMs: 10,
        });
        const origin = yield* getThreadSnapshot({
          authenticationToken,
          baseUrl: slowIngress.origin,
          threadId,
        });
        const healthyCaughtUp = yield* Deferred.make<void>();
        const healthyStream = yield* streamThreadEvents({
          after: origin.throughCursor,
          authenticationToken,
          baseUrl: slowIngress.origin,
          threadId,
        });
        const healthyFiber = yield* healthyStream.pipe(
          Stream.tap((event) =>
            event.event === "caught_up"
              ? Deferred.succeed(healthyCaughtUp, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Stream.take(34),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(healthyCaughtUp).pipe(Effect.timeout("2 seconds"));
        const submissions = Array.from({ length: 32 }, (_, index) => index);
        yield* Effect.forEach(
          submissions,
          (index) =>
            submitThreadMessage({
              authenticationToken,
              baseUrl: slowIngress.origin,
              idempotencyKey: crypto.randomUUID(),
              message: { content: `${String(index).padStart(2, "0")}:${"x".repeat(15_990)}` },
              threadId,
            }),
          { concurrency: 8 },
        );

        const http = yield* HttpClient.HttpClient;
        const response = yield* http.execute(
          HttpClientRequest.get(
            `${slowIngress.origin}/v1/threads/${threadId}/events?after=${encodeURIComponent(origin.throughCursor)}`,
          ).pipe(
            HttpClientRequest.bearerToken(authenticationToken),
            HttpClientRequest.setHeader("accept", "text/event-stream"),
          ),
        );
        expect(response.status).toBe(200);
        const slowClose = yield* slowIngress.waitForSlowConsumerClose.pipe(
          Effect.timeout("2 seconds"),
        );
        expect(slowClose).toMatchObject({
          reason: "slow_consumer",
          status: { activeConnections: 1, slowConsumerCloses: 1 },
        });
        yield* response.stream.pipe(Stream.runDrain, Effect.timeout("2 seconds"));
        const healthyAfterClose = yield* submitThreadMessage({
          authenticationToken,
          baseUrl: slowIngress.origin,
          idempotencyKey: crypto.randomUUID(),
          message: { content: "healthy after slow close" },
          threadId,
        });
        expect(healthyAfterClose.threadPosition).toBe("33");
        const healthyDelivered = Array.from(
          yield* Fiber.join(healthyFiber).pipe(Effect.timeout("2 seconds")),
        );
        expect(
          healthyDelivered.flatMap((event) =>
            event.event === "thread_event" ? [event.data.threadPosition] : [],
          ),
        ).toEqual(Array.from({ length: 33 }, (_, index) => String(index + 1)));
        yield* slowIngress.terminate;

        const replacement = yield* startCompiledIngress({
          databaseUrl,
          maxStreamBufferedBytes: 1_048_576,
          maxStreamBufferedEvents: 64,
          streamPollIntervalMs: 10,
        });
        const replay = yield* streamThreadEvents({
          after: origin.throughCursor,
          authenticationToken,
          baseUrl: replacement.origin,
          threadId,
        });
        const delivered = Array.from(yield* replay.pipe(Stream.take(34), Stream.runCollect));

        expect(
          delivered.flatMap((event) =>
            event.event === "thread_event" ? [event.data.threadPosition] : [],
          ),
        ).toEqual(Array.from({ length: 33 }, (_, index) => String(index + 1)));
        expect(delivered.at(-1)).toMatchObject({
          event: "caught_up",
          data: { throughPosition: "33" },
        });
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    15_000,
  );
});
