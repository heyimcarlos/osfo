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
  readonly afterProducerFork?: Effect.Effect<void>;
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

type ConsumerState = "aborted" | "finished" | "handoff" | "running";

interface ActiveConnection {
  readonly shutdown: (reason: CloseReason) => Effect.Effect<void>;
}

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
    const lifecycleScope = yield* Scope.Scope;
    const supervisorScope = yield* Scope.fork(lifecycleScope, "parallel");
    const state = yield* Ref.make<LifecycleState>({
      accepting: true,
      activeConnections: 0,
      slowConsumerCloses: 0,
    });
    const fullyDrained = yield* Deferred.make<void>();
    const connections = yield* Ref.make<ReadonlyMap<number, ActiveConnection>>(new Map());
    const nextConnectionId = yield* Ref.make(0);

    const drain = Effect.gen(function* () {
      const alreadyDrained = yield* Ref.modify(state, (current) => [
        current.activeConnections === 0,
        { ...current, accepting: false },
      ]);
      if (alreadyDrained) yield* Deferred.succeed(fullyDrained, undefined);
      const active = yield* Ref.get(connections);
      yield* Effect.forEach(active.values(), (connection) => connection.shutdown("drain"), {
        concurrency: "unbounded",
      });
      yield* Deferred.await(fullyDrained);
    });

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
    ): Effect.Effect<{
      readonly shutdown: (reason: CloseReason) => Effect.Effect<void>;
      readonly stream: Stream.Stream<ThreadStreamEvent, ThreadResumeUnavailable>;
    }> =>
      Effect.gen(function* () {
        const connectionId = yield* Ref.getAndUpdate(nextConnectionId, (current) => current + 1);
        const connectionScope = yield* Scope.make("sequential");
        const queue = yield* Queue.dropping<BufferedEvent, Cause.Done | ThreadResumeUnavailable>(
          config.maxBufferedEvents,
        );
        const buffer = yield* Ref.make<BufferState>({ bytes: 0, events: [] });
        const ageWatcherStarted = yield* Ref.make(false);
        const close = yield* Deferred.make<CloseReason>();
        const consumerDone = yield* Deferred.make<void>();
        const consumerState = yield* Ref.make<ConsumerState>("handoff");
        const released = yield* Deferred.make<void>();
        let nextId = 0;

        const closeOnce = (reason: CloseReason) =>
          Deferred.succeed(close, reason).pipe(Effect.asVoid, Effect.uninterruptible);

        yield* Scope.addFinalizer(
          connectionScope,
          Deferred.await(close).pipe(
            Effect.flatMap((reason) => releaseConnectionOnce(reason === "slow_consumer")),
            Effect.andThen(
              Ref.update(connections, (current) => {
                const updated = new Map(current);
                updated.delete(connectionId);
                return updated;
              }),
            ),
            Effect.andThen(Deferred.succeed(released, undefined)),
            Effect.asVoid,
          ),
        );
        yield* Scope.addFinalizer(connectionScope, Queue.shutdown(queue));

        yield* Effect.sleep(config.maxConnectionLifetimeMs).pipe(
          Effect.andThen(closeOnce("maximum_lifetime")),
          Effect.raceFirst(Deferred.await(close)),
          Effect.forkIn(connectionScope),
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
                  Effect.forkIn(connectionScope),
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
        yield* Effect.forkIn(producer, connectionScope);

        const abortConsumerHandoff = Ref.modify(consumerState, (current) =>
          current === "handoff" ? [true, "aborted" as const] : ([false, current] as const),
        ).pipe(
          Effect.flatMap((aborted) =>
            aborted ? Deferred.succeed(consumerDone, undefined) : Effect.void,
          ),
          Effect.asVoid,
        );

        const shutdown = (reason: CloseReason) =>
          closeOnce(reason).pipe(Effect.andThen(Deferred.await(released)), Effect.uninterruptible);

        yield* Ref.update(connections, (current) => {
          const updated = new Map(current);
          updated.set(connectionId, { shutdown });
          return updated;
        });
        yield* Deferred.await(close).pipe(
          Effect.andThen(abortConsumerHandoff),
          Effect.andThen(Deferred.await(consumerDone)),
          Effect.andThen(Scope.close(connectionScope, Exit.void)),
          Effect.forkIn(supervisorScope),
        );

        const beginConsumer = Ref.modify(consumerState, (current) =>
          current === "handoff" ? [true, "running" as const] : ([false, current] as const),
        );
        const finishConsumer = closeOnce("client_disconnect").pipe(
          Effect.andThen(
            Ref.update(consumerState, (current) => (current === "running" ? "finished" : current)),
          ),
          Effect.andThen(Deferred.succeed(consumerDone, undefined)),
          Effect.asVoid,
          Effect.uninterruptible,
        );

        const consumer = Stream.fromEffectRepeat(Queue.take(queue)).pipe(
          Stream.mapEffect((item) =>
            Ref.update(buffer, (current) => ({
              bytes: current.bytes - item.bytes,
              events: current.events.filter((candidate) => candidate.id !== item.id),
            })).pipe(Effect.as(item.value)),
          ),
          Stream.interruptWhen(Deferred.await(close)),
        );
        const stream = Stream.fromEffect(beginConsumer).pipe(
          Stream.flatMap((started) => (started ? consumer : Stream.empty)),
          Stream.ensuring(finishConsumer),
        );
        return { shutdown, stream };
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
          return yield* Effect.gen(function* () {
            yield* restore(hooks.beforeProtect);
            const connection = yield* protect(source, releaseConnectionOnce);
            yield* restore(hooks.afterProducerFork ?? Effect.void).pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit) ? Effect.void : connection.shutdown("client_disconnect"),
              ),
            );
            if (!(yield* Ref.get(state)).accepting) {
              yield* connection.shutdown("drain");
              return yield* new ThreadResumeUnavailable();
            }
            return connection.stream;
          }).pipe(
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
