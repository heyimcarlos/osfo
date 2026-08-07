import { OutboxRelay } from "@osfo/agent-run";
import { Effect, Schema } from "effect";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

export const OutboxRelayProcessConfigSchema = Schema.Struct({
  idlePollIntervalMs: PositiveInteger,
  publisherConcurrency: PositiveInteger,
});

export type OutboxRelayProcessConfig = typeof OutboxRelayProcessConfigSchema.Type;

export const runOutboxRelay = (config: OutboxRelayProcessConfig) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("OSFO_OUTBOX_RELAY_READY");
    const relay = yield* OutboxRelay;
    const selector = Effect.forever(
      relay.selectOnce().pipe(
        Effect.flatMap((result) =>
          result.type === "idle" ? Effect.sleep(config.idlePollIntervalMs) : Effect.yieldNow,
        ),
        Effect.catch((cause) =>
          Effect.logError("Outbox selector iteration failed", cause).pipe(
            Effect.andThen(Effect.sleep(config.idlePollIntervalMs)),
          ),
        ),
      ),
    );
    const publishers = Effect.forEach(
      Array.from({ length: config.publisherConcurrency }),
      () =>
        Effect.forever(
          relay.publishOnce().pipe(
            Effect.flatMap((result) =>
              result.type === "idle" ? Effect.sleep(config.idlePollIntervalMs) : Effect.yieldNow,
            ),
            Effect.catch((cause) =>
              Effect.logError("Outbox publisher iteration failed", cause).pipe(
                Effect.andThen(Effect.sleep(config.idlePollIntervalMs)),
              ),
            ),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
    yield* Effect.all([selector, publishers], { concurrency: "unbounded", discard: true });
  });
