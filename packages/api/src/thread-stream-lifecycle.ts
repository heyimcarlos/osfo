import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { ThreadStreamEvent } from "./threads/api.js";
import { ConnectionLimitExceeded, ThreadResumeUnavailable } from "./threads/api.js";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

export const ThreadStreamLifecycleConfigSchema = Schema.Struct({
  maxBufferedAgeMs: PositiveInteger,
  maxBufferedBytes: PositiveInteger,
  maxBufferedEvents: PositiveInteger,
  maxConnectionLifetimeMs: PositiveInteger,
  maxConnections: PositiveInteger,
});

export type ThreadStreamLifecycleConfig = typeof ThreadStreamLifecycleConfigSchema.Type;

export class InvalidThreadStreamLifecycleConfig extends Data.TaggedError(
  "InvalidThreadStreamLifecycleConfig",
)<{ readonly cause: unknown }> {}

export interface ThreadStreamLifecycleStatus {
  readonly accepting: boolean;
  readonly activeConnections: number;
  readonly slowConsumerCloses: number;
}

export interface ThreadStreamLifecycleTestHooks {
  readonly beforeProtect: Effect.Effect<void, ThreadResumeUnavailable>;
}

type LifecycleState = ThreadStreamLifecycleStatus;

interface BufferedEvent {
  readonly bytes: number;
  readonly enqueuedAt: number;
  readonly id: number;
  readonly value: ThreadStreamEvent;
}

interface BufferState {
  readonly bytes: number;
  readonly events: ReadonlyArray<BufferedEvent>;
}

type CloseReason =
  | "client_disconnect"
  | "drain"
  | "maximum_lifetime"
  | "slow_consumer"
  | "source_unavailable";

export const threadStreamConnectionRetryAfterSeconds = 5;

export interface ThreadStreamLifecycleService {
  readonly drain: Effect.Effect<void>;
  readonly open: (
    source: Stream.Stream<ThreadStreamEvent, ThreadResumeUnavailable>,
  ) => Effect.Effect<
    Stream.Stream<ThreadStreamEvent, ThreadResumeUnavailable>,
    ConnectionLimitExceeded | ThreadResumeUnavailable
  >;
  readonly status: Effect.Effect<ThreadStreamLifecycleStatus>;
}

export class ThreadStreamLifecycle extends Context.Service<
  ThreadStreamLifecycle,
  ThreadStreamLifecycleService
>()("@osfo/api/ThreadStreamLifecycle") {}

const encoder = new TextEncoder();

const encodedBytes = (event: ThreadStreamEvent) =>
  encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).byteLength;

const makeLifecycle = (
  config: ThreadStreamLifecycleConfig,
  hooks: ThreadStreamLifecycleTestHooks,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const state = yield* Ref.make<LifecycleState>({
      accepting: true,
      activeConnections: 0,
      slowConsumerCloses: 0,
    });
    const draining = yield* Deferred.make<void>();
    const fullyDrained = yield* Deferred.make<void>();

    const drain = Ref.modify(state, (current) => [
      current.activeConnections === 0,
      { ...current, accepting: false },
    ]).pipe(
      Effect.flatMap((alreadyDrained) =>
        Deferred.succeed(draining, undefined).pipe(
          Effect.andThen(alreadyDrained ? Deferred.succeed(fullyDrained, undefined) : Effect.void),
          Effect.andThen(Deferred.await(fullyDrained)),
        ),
      ),
      Effect.asVoid,
    );

    const releaseConnection = (slowConsumer: boolean) =>
      Ref.modify(state, (current) => {
        const updated = {
          ...current,
          activeConnections: Math.max(0, current.activeConnections - 1),
          slowConsumerCloses: current.slowConsumerCloses + (slowConsumer ? 1 : 0),
        };
        return [!updated.accepting && updated.activeConnections === 0, updated] as const;
      }).pipe(
        Effect.flatMap((completedDrain) =>
          completedDrain ? Deferred.succeed(fullyDrained, undefined) : Effect.void,
        ),
        Effect.andThen(
          slowConsumer ? Effect.logWarning("Thread stream closed: slow_consumer") : Effect.void,
        ),
      );

    const protect = (
      source: Stream.Stream<ThreadStreamEvent, ThreadResumeUnavailable>,
      releaseConnectionOnce: (slowConsumer: boolean) => Effect.Effect<void>,
    ): Effect.Effect<Stream.Stream<ThreadStreamEvent, ThreadResumeUnavailable>> =>
      Effect.gen(function* () {
        const queue = yield* Queue.dropping<BufferedEvent, Cause.Done | ThreadResumeUnavailable>(
          config.maxBufferedEvents,
        );
        const buffer = yield* Ref.make<BufferState>({ bytes: 0, events: [] });
        const ageWatcherStarted = yield* Ref.make(false);
        const close = yield* Deferred.make<CloseReason>();
        let nextId = 0;

        const closeOnce = (reason: CloseReason) =>
          Deferred.succeed(close, reason).pipe(
            Effect.flatMap((closed) =>
              closed ? releaseConnectionOnce(reason === "slow_consumer") : Effect.void,
            ),
            Effect.uninterruptible,
          );

        yield* Deferred.await(draining).pipe(
          Effect.andThen(closeOnce("drain")),
          Effect.raceFirst(Deferred.await(close)),
          Effect.forkIn(scope),
        );
        yield* Effect.sleep(config.maxConnectionLifetimeMs).pipe(
          Effect.andThen(closeOnce("maximum_lifetime")),
          Effect.raceFirst(Deferred.await(close)),
          Effect.forkIn(scope),
        );
        const watchBufferAge = Effect.gen(function* () {
          while (true) {
            const oldest = (yield* Ref.get(buffer)).events[0];
            if (oldest === undefined) {
              yield* Effect.sleep(config.maxBufferedAgeMs);
            } else {
              const age = (yield* Clock.currentTimeMillis) - oldest.enqueuedAt;
              if (age >= config.maxBufferedAgeMs) {
                yield* closeOnce("slow_consumer");
                return;
              }
              yield* Effect.sleep(config.maxBufferedAgeMs - age);
            }
          }
        });

        const producer = source.pipe(
          Stream.runForEach((value) =>
            Effect.gen(function* () {
              const bytes = encodedBytes(value);
              const enqueuedAt = yield* Clock.currentTimeMillis;
              nextId += 1;
              const item = { bytes, enqueuedAt, id: nextId, value } satisfies BufferedEvent;
              const admitted = yield* Ref.modify(buffer, (current) => {
                if (
                  current.events.length >= config.maxBufferedEvents ||
                  current.bytes + bytes > config.maxBufferedBytes
                ) {
                  return [false, current] as const;
                }
                return [
                  true,
                  {
                    bytes: current.bytes + bytes,
                    events: [...current.events, item],
                  },
                ] as const;
              });
              if (!admitted) {
                yield* closeOnce("slow_consumer");
                return;
              }
              if (!(yield* Ref.getAndSet(ageWatcherStarted, true))) {
                yield* watchBufferAge.pipe(
                  Effect.raceFirst(Deferred.await(close)),
                  Effect.forkIn(scope),
                );
              }
              const offered = yield* Queue.offer(queue, item);
              if (!offered) {
                yield* Ref.update(buffer, (current) => ({
                  bytes: current.bytes - bytes,
                  events: current.events.filter((candidate) => candidate.id !== item.id),
                }));
                yield* closeOnce("slow_consumer");
                return;
              }
            }),
          ),
          Effect.raceFirst(Deferred.await(close)),
          Effect.matchCauseEffect({
            onFailure: () =>
              Queue.clear(queue).pipe(
                Effect.andThen(Ref.set(buffer, { bytes: 0, events: [] })),
                Effect.andThen(Queue.end(queue)),
                Effect.andThen(closeOnce("source_unavailable")),
              ),
            onSuccess: () => Queue.end(queue),
          }),
        );
        yield* Effect.forkIn(producer, scope);

        return Stream.fromEffectRepeat(Queue.take(queue)).pipe(
          Stream.mapEffect((item) =>
            Ref.update(buffer, (current) => ({
              bytes: current.bytes - item.bytes,
              events: current.events.filter((candidate) => candidate.id !== item.id),
            })).pipe(Effect.as(item.value)),
          ),
          Stream.interruptWhen(Deferred.await(close)),
          Stream.ensuring(
            closeOnce("client_disconnect").pipe(Effect.andThen(Queue.shutdown(queue))),
          ),
        );
      });

    const open = Effect.fn("ThreadStreamLifecycle.open")(function* (
      source: Stream.Stream<ThreadStreamEvent, ThreadResumeUnavailable>,
    ) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const result = yield* Ref.modify(state, (current) => {
            if (!current.accepting) return ["draining" as const, current] as const;
            if (current.activeConnections >= config.maxConnections) {
              return ["full" as const, current] as const;
            }
            return [
              "opened" as const,
              { ...current, activeConnections: current.activeConnections + 1 },
            ] as const;
          });
          if (result === "full") {
            return yield* new ConnectionLimitExceeded({
              retryAfterSeconds: threadStreamConnectionRetryAfterSeconds,
            });
          }
          if (result === "draining") return yield* new ThreadResumeUnavailable();

          const released = yield* Ref.make(false);
          const releaseConnectionOnce = (slowConsumer: boolean) =>
            Ref.getAndSet(released, true).pipe(
              Effect.flatMap((alreadyReleased) =>
                alreadyReleased ? Effect.void : releaseConnection(slowConsumer),
              ),
            );
          return yield* restore(
            hooks.beforeProtect.pipe(Effect.andThen(protect(source, releaseConnectionOnce))),
          ).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : releaseConnectionOnce(false),
            ),
          );
        }),
      );
    });

    return ThreadStreamLifecycle.of({ drain, open, status: Ref.get(state) });
  });

const lifecycleLayer = (
  config: ThreadStreamLifecycleConfig,
  hooks: ThreadStreamLifecycleTestHooks,
) =>
  Layer.effect(
    ThreadStreamLifecycle,
    Effect.acquireRelease(makeLifecycle(config, hooks), (lifecycle) => lifecycle.drain),
  );

const makeLayer = (config: ThreadStreamLifecycleConfig, hooks: ThreadStreamLifecycleTestHooks) =>
  Layer.unwrap(
    Schema.decodeUnknownEffect(ThreadStreamLifecycleConfigSchema)(config).pipe(
      Effect.mapError((cause) => new InvalidThreadStreamLifecycleConfig({ cause })),
      Effect.map((decoded) => lifecycleLayer(decoded, hooks)),
    ),
  );

export const makeThreadStreamLifecycleLayer = (config: ThreadStreamLifecycleConfig) =>
  makeLayer(config, { beforeProtect: Effect.void });

export const makeThreadStreamLifecycleTestLayer = (
  config: ThreadStreamLifecycleConfig,
  hooks: ThreadStreamLifecycleTestHooks,
) => makeLayer(config, hooks);
