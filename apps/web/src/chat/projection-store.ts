import {
  ThreadSnapshotSchema,
  applyThreadEvent,
  type InvalidThreadProjection,
  type ThreadEventEnvelope,
  type ThreadSnapshot,
} from "@osfo/session";
import { Data, Effect, Schema } from "effect";

export class ProjectionStoreCorrupt extends Data.TaggedError("ProjectionStoreCorrupt")<{
  readonly cause?: unknown;
}> {}

export class ProjectionStoreUnavailable extends Data.TaggedError("ProjectionStoreUnavailable")<{
  readonly cause: unknown;
}> {}

export interface ThreadProjectionStoreOptions {
  readonly storage: Storage;
  readonly threadId: string;
}

export interface ThreadProjectionStore {
  readonly apply: (
    event: ThreadEventEnvelope,
  ) => Effect.Effect<
    ThreadSnapshot,
    InvalidThreadProjection | ProjectionStoreCorrupt | ProjectionStoreUnavailable
  >;
  readonly load: () => Effect.Effect<
    ThreadSnapshot | undefined,
    ProjectionStoreCorrupt | ProjectionStoreUnavailable
  >;
  readonly replace: (
    snapshot: ThreadSnapshot,
  ) => Effect.Effect<void, ProjectionStoreCorrupt | ProjectionStoreUnavailable>;
}

export const makeThreadProjectionStore = ({ storage, threadId }: ThreadProjectionStoreOptions) => {
  const key = `osfo.thread-projection.v1.${threadId}`;

  const load = Effect.fn("ThreadProjectionStore.load")(function* () {
    const encoded = yield* Effect.try({
      try: () => storage.getItem(key),
      catch: (cause) => new ProjectionStoreUnavailable({ cause }),
    });
    if (encoded === null) return undefined;
    const decoded = yield* Effect.try({
      try: () => JSON.parse(encoded) as unknown,
      catch: (cause) => new ProjectionStoreCorrupt({ cause }),
    });
    const snapshot = yield* Schema.decodeUnknownEffect(ThreadSnapshotSchema)(decoded).pipe(
      Effect.mapError((cause) => new ProjectionStoreCorrupt({ cause })),
    );
    if (snapshot.threadId !== threadId) return yield* new ProjectionStoreCorrupt({});
    return snapshot;
  });

  const replace = Effect.fn("ThreadProjectionStore.replace")(function* (snapshot: ThreadSnapshot) {
    if (snapshot.threadId !== threadId) return yield* new ProjectionStoreCorrupt({});
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ThreadSnapshotSchema))(
      snapshot,
    ).pipe(Effect.mapError((cause) => new ProjectionStoreCorrupt({ cause })));
    yield* Effect.try({
      try: () => storage.setItem(key, encoded),
      catch: (cause) => new ProjectionStoreUnavailable({ cause }),
    });
  });

  const apply = Effect.fn("ThreadProjectionStore.apply")(function* (event: ThreadEventEnvelope) {
    const current = yield* load();
    if (current === undefined) return yield* new ProjectionStoreCorrupt({});
    const updated = yield* applyThreadEvent(current, event);
    if (updated !== current) yield* replace(updated);
    return updated;
  });

  return { apply, load, replace } satisfies ThreadProjectionStore;
};
