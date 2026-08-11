import { OutboxRelay } from "@osfo/agent-run";
import { Effect, Metric, PubSub, Schema, Stream } from "effect";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

export const OutboxRelayProcessConfigSchema = Schema.Struct({
  publisherConcurrency: PositiveInteger,
  safetyDrainIntervalMs: PositiveInteger,
});

export type OutboxRelayProcessConfig = typeof OutboxRelayProcessConfigSchema.Type;

export const outboxRelayMetrics = {
  emptySelectorChecks: Metric.counter("osfo_outbox_relay_empty_selector_checks_total", {
    description: "Selector database checks that found no eligible publication work",
  }),
  nonEmptySelectionBatches: Metric.counter("osfo_outbox_relay_non_empty_selection_batches_total", {
    description: "Selector database checks that created a non-empty publication batch",
  }),
  notifications: Metric.counter("osfo_outbox_relay_notifications_total", {
    description: "PostgreSQL notifications observed by the relay wake listener",
  }),
  reconnects: Metric.counter("osfo_outbox_relay_reconnects_total", {
    description: "Successful PostgreSQL wake-listener reconnections",
  }),
  safetyEvents: Metric.counter("osfo_outbox_relay_safety_events_total", {
    description: "Periodic safety drains used to recover lost wake hints",
  }),
} as const;

export const runOutboxRelay = (config: OutboxRelayProcessConfig) =>
  Effect.scoped(
    Effect.gen(function* () {
      const relay = yield* OutboxRelay;
      const selectorWakes = yield* PubSub.sliding<"wake">(1);
      const publisherWakes = yield* PubSub.sliding<"wake">(1);
      const selectorSubscription = yield* PubSub.subscribe(selectorWakes);
      const publisherSubscriptions = yield* Effect.forEach(
        Array.from({ length: config.publisherConcurrency }),
        () => PubSub.subscribe(publisherWakes),
      );
      const wakeSelector = PubSub.publish(selectorWakes, "wake");
      const wakePublishers = PubSub.publish(publisherWakes, "wake");
      const wakeAll = Effect.all([wakeSelector, wakePublishers], { discard: true });

      const drainSelector = Effect.gen(function* () {
        while (true) {
          const result = yield* relay.selectOnce();
          if (result.type === "idle") {
            yield* Metric.update(outboxRelayMetrics.emptySelectorChecks, 1);
            return;
          }
          yield* Metric.update(outboxRelayMetrics.nonEmptySelectionBatches, 1);
          yield* wakePublishers;
        }
      }).pipe(Effect.catch((cause) => Effect.logError("Outbox selector drain failed", cause)));
      const drainPublisher = Effect.gen(function* () {
        while (true) {
          const result = yield* relay.publishOnce();
          if (result.type === "idle") return;
          yield* wakeSelector;
        }
      }).pipe(Effect.catch((cause) => Effect.logError("Outbox publisher drain failed", cause)));
      const selector = Effect.forever(
        PubSub.take(selectorSubscription).pipe(Effect.andThen(drainSelector)),
      );
      const publishers = Effect.forEach(
        publisherSubscriptions,
        (subscription) =>
          Effect.forever(PubSub.take(subscription).pipe(Effect.andThen(drainPublisher))),
        { concurrency: "unbounded", discard: true },
      );
      const databaseWakes = Effect.forever(
        wakeAll.pipe(
          Effect.andThen(
            Stream.runForEach(relay.wakeEvents, (event) =>
              Effect.gen(function* () {
                if (event.type === "notification") {
                  yield* Metric.update(outboxRelayMetrics.notifications, 1);
                } else if (event.reconnect) {
                  yield* Metric.update(outboxRelayMetrics.reconnects, 1);
                }
                yield* wakeSelector;
              }),
            ),
          ),
          Effect.catch((cause) =>
            Effect.logError("Outbox relay wake listener failed", cause).pipe(
              Effect.andThen(Effect.sleep(config.safetyDrainIntervalMs)),
            ),
          ),
        ),
      );
      const safetyDrain = Effect.forever(
        Effect.sleep(config.safetyDrainIntervalMs).pipe(
          Effect.andThen(Metric.update(outboxRelayMetrics.safetyEvents, 1)),
          Effect.andThen(wakeAll),
        ),
      );

      yield* Effect.forkScoped(
        Effect.all([selector, publishers, databaseWakes, safetyDrain], {
          concurrency: "unbounded",
          discard: true,
        }),
      );
      yield* wakeAll;
      yield* Effect.logInfo("OSFO_OUTBOX_RELAY_READY");
      return yield* Effect.never;
    }),
  );
