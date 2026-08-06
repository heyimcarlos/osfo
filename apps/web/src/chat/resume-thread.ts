import {
  ThreadResumeUnavailable,
  type ThreadSnapshotError,
  type ThreadStreamEvent,
  type ThreadResumeError,
} from "@osfo/api";
import { InvalidThreadProjection, type ThreadSnapshot } from "@osfo/session";
import { Effect, Stream } from "effect";
import {
  ProjectionStoreCorrupt,
  ProjectionStoreUnavailable,
  type ThreadProjectionStore,
} from "./projection-store";

export interface ThreadResumeTransport {
  readonly snapshot: () => Effect.Effect<ThreadSnapshot, ThreadSnapshotError>;
  readonly stream: (
    cursor: string,
  ) => Effect.Effect<Stream.Stream<ThreadStreamEvent, ThreadResumeUnavailable>, ThreadResumeError>;
}

export interface SynchronizeThreadOptions {
  readonly onProjection?: (snapshot: ThreadSnapshot) => void;
  readonly store: ThreadProjectionStore;
  readonly transport: ThreadResumeTransport;
}

export type SynchronizeThreadError =
  | InvalidThreadProjection
  | ProjectionStoreCorrupt
  | ProjectionStoreUnavailable
  | ThreadSnapshotError
  | ThreadResumeError
  | ThreadResumeUnavailable;

const notify = (options: SynchronizeThreadOptions, snapshot: ThreadSnapshot) =>
  Effect.sync(() => options.onProjection?.(snapshot));

const replaceFromAuthority = Effect.fn("ThreadResume.replaceFromAuthority")(function* (
  options: SynchronizeThreadOptions,
) {
  const snapshot = yield* options.transport.snapshot();
  yield* options.store.replace(snapshot);
  yield* notify(options, snapshot);
  return snapshot;
});

const openRetainedStream = Effect.fn("ThreadResume.openRetainedStream")(function* (
  options: SynchronizeThreadOptions,
  snapshot: ThreadSnapshot,
) {
  return yield* options.transport
    .stream(snapshot.throughCursor)
    .pipe(
      Effect.catchTag("CursorOutsideRetention", () =>
        replaceFromAuthority(options).pipe(
          Effect.flatMap((replacement) => options.transport.stream(replacement.throughCursor)),
        ),
      ),
    );
});

export const synchronizeThreadOnce = Effect.fn("ThreadResume.synchronizeThreadOnce")(function* (
  options: SynchronizeThreadOptions,
): Effect.fn.Return<void, SynchronizeThreadError> {
  const persisted = yield* options.store
    .load()
    .pipe(Effect.catchTag("ProjectionStoreCorrupt", () => Effect.succeed(undefined)));
  const initial = persisted ?? (yield* replaceFromAuthority(options));
  if (persisted !== undefined) yield* notify(options, persisted);
  const events = yield* openRetainedStream(options, initial);

  yield* events.pipe(
    Stream.runForEach((message) =>
      message.event === "caught_up"
        ? Effect.void
        : options.store.apply(message.data).pipe(
            Effect.tap((snapshot) => notify(options, snapshot)),
            Effect.asVoid,
          ),
    ),
    Effect.catchIf(
      (error): error is InvalidThreadProjection =>
        error instanceof InvalidThreadProjection && error.reason === "gap",
      () => replaceFromAuthority(options).pipe(Effect.asVoid),
    ),
  );
});
