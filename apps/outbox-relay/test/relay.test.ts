import { OutboxRelay, type RunnableAgentRunDelivery } from "@osfo/agent-run";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Metric, Option, PubSub, Stream } from "effect";
import { outboxRelayMetrics, runOutboxRelay } from "../src/relay.js";

const delivery: RunnableAgentRunDelivery = {
  version: 1,
  deliveryId: "a0ebd399-4f59-4655-8f17-7a2bd6799cd6",
  agentRunId: "5f3b02e3-fd65-4234-8114-4f175117e663",
  threadId: "0bad3fa0-a81a-4184-99f2-8f4aafc72c80",
  executionProfileRef: "oz.deterministic.v1",
};

describe("outbox relay process", () => {
  it.live("responds to a database wake without waiting for the safety drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wakes = yield* PubSub.sliding<string>({ capacity: 1, replay: 1 });
        const notificationsBefore = yield* Metric.value(outboxRelayMetrics.notifications);
        const emptyChecksBefore = yield* Metric.value(outboxRelayMetrics.emptySelectorChecks);
        const batchesBefore = yield* Metric.value(outboxRelayMetrics.nonEmptySelectionBatches);
        const initialCheck = yield* Deferred.make<void>();
        const publishersIdle = yield* Deferred.make<void>();
        const publication = yield* Deferred.make<void>();
        let ready = false;
        let selected = false;
        let idlePublisherCount = 0;
        const relay = OutboxRelay.of({
          wakeEvents: Stream.fromPubSub(wakes).pipe(
            Stream.map(() => ({ type: "notification" as const })),
          ),
          selectOnce: () =>
            Effect.sync(() => {
              Deferred.doneUnsafe(initialCheck, Effect.void);
              if (!ready || selected) return { type: "idle" as const };
              selected = true;
              return { type: "selected" as const, outboxIds: [delivery.deliveryId] };
            }),
          publishOnce: () =>
            Effect.sync(() => {
              if (!selected) {
                idlePublisherCount += 1;
                if (idlePublisherCount === 4) {
                  Deferred.doneUnsafe(publishersIdle, Effect.void);
                }
                return { type: "idle" as const };
              }
              selected = false;
              Deferred.doneUnsafe(publication, Effect.void);
              return { type: "published" as const, delivery };
            }),
        });
        const process = yield* Effect.forkChild(
          runOutboxRelay({ publisherConcurrency: 4, safetyDrainIntervalMs: 60_000 }).pipe(
            Effect.provide(Layer.succeed(OutboxRelay)(relay)),
          ),
        );

        const initialized = yield* Effect.all([
          Deferred.await(initialCheck),
          Deferred.await(publishersIdle),
        ]).pipe(Effect.timeoutOption(500));
        expect({ initialized: Option.isSome(initialized), idlePublisherCount }).toEqual({
          initialized: true,
          idlePublisherCount: 4,
        });
        ready = true;
        yield* PubSub.publish(wakes, "wake");
        const observed = yield* Deferred.await(publication).pipe(Effect.timeoutOption(500));
        const notificationsAfter = yield* Metric.value(outboxRelayMetrics.notifications);
        const emptyChecksAfter = yield* Metric.value(outboxRelayMetrics.emptySelectorChecks);
        const batchesAfter = yield* Metric.value(outboxRelayMetrics.nonEmptySelectionBatches);
        yield* Fiber.interrupt(process);

        expect(Option.isSome(observed)).toBe(true);
        expect(notificationsAfter.count).toBeGreaterThan(notificationsBefore.count);
        expect(emptyChecksAfter.count).toBeGreaterThan(emptyChecksBefore.count);
        expect(batchesAfter.count).toBeGreaterThan(batchesBefore.count);
      }),
    ),
  );

  it.live("runs no more than the configured number of asynchronous publishers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wakes = yield* PubSub.sliding<string>({ capacity: 1, replay: 1 });
        const fourStarted = yield* Deferred.make<void>();
        const initialCheck = yield* Deferred.make<void>();
        const publishersIdle = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const allPublished = yield* Deferred.make<void>();
        let selectionsRemaining = 8;
        let publicationsRemaining = 8;
        let activePublishers = 0;
        let maximumActivePublishers = 0;
        let ready = false;
        let selectedAvailable = 0;
        let idlePublisherCount = 0;
        const relay = OutboxRelay.of({
          wakeEvents: Stream.fromPubSub(wakes).pipe(
            Stream.map(() => ({ type: "notification" as const })),
          ),
          selectOnce: () =>
            Effect.sync(() => {
              Deferred.doneUnsafe(initialCheck, Effect.void);
              if (!ready || selectionsRemaining === 0) return { type: "idle" as const };
              selectionsRemaining -= 1;
              selectedAvailable += 1;
              return { type: "selected" as const, outboxIds: [delivery.deliveryId] };
            }),
          publishOnce: () =>
            Effect.gen(function* () {
              if (selectedAvailable === 0 || publicationsRemaining === 0) {
                idlePublisherCount += 1;
                if (idlePublisherCount === 4) {
                  yield* Deferred.succeed(publishersIdle, undefined);
                }
                return { type: "idle" as const };
              }
              selectedAvailable -= 1;
              publicationsRemaining -= 1;
              activePublishers += 1;
              maximumActivePublishers = Math.max(maximumActivePublishers, activePublishers);
              if (activePublishers === 4) yield* Deferred.succeed(fourStarted, undefined);
              yield* Deferred.await(release);
              activePublishers -= 1;
              if (publicationsRemaining === 0 && activePublishers === 0) {
                yield* Deferred.succeed(allPublished, undefined);
              }
              return { type: "published" as const, delivery };
            }),
        });
        const process = yield* Effect.forkChild(
          runOutboxRelay({ publisherConcurrency: 4, safetyDrainIntervalMs: 60_000 }).pipe(
            Effect.provide(Layer.succeed(OutboxRelay)(relay)),
          ),
        );

        const initialized = yield* Effect.all([
          Deferred.await(initialCheck),
          Deferred.await(publishersIdle),
        ]).pipe(Effect.timeoutOption(500));
        expect({ initialized: Option.isSome(initialized), idlePublisherCount }).toEqual({
          initialized: true,
          idlePublisherCount: 4,
        });
        ready = true;
        yield* PubSub.publish(wakes, "wake");
        const started = yield* Deferred.await(fourStarted).pipe(Effect.timeoutOption(500));
        expect(Option.isSome(started)).toBe(true);
        expect(maximumActivePublishers).toBe(4);
        yield* Deferred.succeed(release, undefined);
        const completed = yield* Deferred.await(allPublished).pipe(Effect.timeoutOption(500));
        yield* Fiber.interrupt(process);

        expect(Option.isSome(completed)).toBe(true);
        expect(maximumActivePublishers).toBe(4);
      }),
    ),
  );

  it.live("recovers work when a database wake is lost", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initialCheck = yield* Deferred.make<void>();
        const publishersIdle = yield* Deferred.make<void>();
        const publication = yield* Deferred.make<void>();
        let ready = false;
        let selected = false;
        let idlePublisherCount = 0;
        const relay = OutboxRelay.of({
          wakeEvents: Stream.never,
          selectOnce: () =>
            Effect.sync(() => {
              Deferred.doneUnsafe(initialCheck, Effect.void);
              if (!ready || selected) return { type: "idle" as const };
              selected = true;
              return { type: "selected" as const, outboxIds: [delivery.deliveryId] };
            }),
          publishOnce: () =>
            Effect.sync(() => {
              if (!selected) {
                idlePublisherCount += 1;
                if (idlePublisherCount === 4) {
                  Deferred.doneUnsafe(publishersIdle, Effect.void);
                }
                return { type: "idle" as const };
              }
              selected = false;
              Deferred.doneUnsafe(publication, Effect.void);
              return { type: "published" as const, delivery };
            }),
        });
        const process = yield* Effect.forkChild(
          runOutboxRelay({ publisherConcurrency: 4, safetyDrainIntervalMs: 50 }).pipe(
            Effect.provide(Layer.succeed(OutboxRelay)(relay)),
          ),
        );
        const initialized = yield* Effect.all([
          Deferred.await(initialCheck),
          Deferred.await(publishersIdle),
        ]).pipe(Effect.timeoutOption(500));
        expect(Option.isSome(initialized)).toBe(true);

        yield* Effect.sleep(20);
        const safetyEventsBefore = yield* Metric.value(outboxRelayMetrics.safetyEvents);
        ready = true;
        const recovered = yield* Deferred.await(publication).pipe(Effect.timeoutOption(500));
        const safetyEventsAfter = yield* Metric.value(outboxRelayMetrics.safetyEvents);
        yield* Fiber.interrupt(process);

        expect(Option.isSome(recovered)).toBe(true);
        expect(safetyEventsAfter.count).toBeGreaterThan(safetyEventsBefore.count);
      }),
    ),
  );
});
