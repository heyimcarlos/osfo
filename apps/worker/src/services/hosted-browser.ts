/* oxlint-disable eslint/no-underscore-dangle -- Browser outcomes use the canonical wire discriminator. */
/* oxlint-disable osfo/no-unknown-parameters, osfo/no-unknown-returns -- This module owns the durable storage boundary and decodes every read before use. */
import {
  BrowserObservation,
  BrowserOutcome,
  BrowserRequest,
  encodeBrowserRequest,
  type InventoryRequest,
  type InventoryResponse,
} from "@osfo/api/browser-host";
import type { BrowserBinding } from "agents/browser";
import { Clock, Effect, Schema, Semaphore } from "effect";
import { HostedBrowserProvider } from "./hosted-browser-provider";
import { HostedBrowserUsage } from "./hosted-browser-usage";

export { Unavailable } from "./hosted-browser-provider";
export type Provider = HostedBrowserProvider.Provider;
export const taskLifetimeMilliseconds = HostedBrowserUsage.taskLifetimeMilliseconds;
const orphanLifetimeMilliseconds = HostedBrowserUsage.maximumLifetimeMilliseconds;
export interface Storage {
  readonly get: (key: string) => Promise<unknown>;
  readonly put: (key: string, value: unknown) => Promise<void>;
  readonly delete: (key: string) => Promise<boolean>;
  readonly list: (options: { readonly prefix: string }) => Promise<Map<string, unknown>>;
}
export interface Options {
  readonly storage: Storage;
  readonly browser?: BrowserBinding;
  readonly provider?: Provider;
  readonly ownerUserId: string;
  readonly hostSessionId: string;
  readonly now?: Effect.Effect<number>;
  readonly usage?: {
    readonly start: (
      request: BrowserRequest,
    ) => Effect.Effect<void, HostedBrowserProvider.Unavailable>;
    readonly close: (taskId: string) => Effect.Effect<void, HostedBrowserProvider.Unavailable>;
    readonly observed: (taskId: string) => Effect.Effect<void, HostedBrowserProvider.Unavailable>;
    readonly cancel: (taskId: string) => Effect.Effect<void, HostedBrowserProvider.Unavailable>;
  };
}
const Task = Schema.Struct({
  taskId: Schema.String,
  ownerUserId: Schema.String,
  hostSessionId: Schema.String,
  origin: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  targetId: Schema.NullOr(Schema.String),
  expiresAt: Schema.Int,
  orphanExpiresAt: Schema.Int,
  creationDispatched: Schema.Boolean,
  handoffId: Schema.NullOr(Schema.String),
  closed: Schema.Boolean,
  paused: Schema.Boolean,
  pendingOperationId: Schema.NullOr(Schema.String),
  observation: Schema.NullOr(BrowserObservation),
});
type Task = typeof Task.Type;
const Operation = Schema.Struct({ request: Schema.String, outcome: Schema.NullOr(BrowserOutcome) });
const locks = new WeakMap<Storage, Semaphore.Semaphore>();
const unavailable = HostedBrowserProvider.unavailable;
const boundary = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: unavailable });
const decode = <A>(schema: Schema.Codec<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(unavailable));
const taskKey = (id: string) => `hosted-browser:task:${id}`;
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const operationKey = (taskId: string, operationId: string) =>
  `hosted-browser:operation:${encodeIdentity([taskId, operationId])}`;

/** The owning Agent retains dispatch claims and cleanup obligations independently of provider sockets. */
export const make = (options: Options) => {
  const existingLock = locks.get(options.storage);
  const lock = existingLock ?? Semaphore.makeUnsafe(1);
  if (existingLock === undefined) locks.set(options.storage, lock);
  const run = <A>(effect: Effect.Effect<A, HostedBrowserProvider.Unavailable>) =>
    lock.withPermit(effect).pipe(Effect.timeout("25 seconds"), Effect.mapError(unavailable));
  const provider =
    options.provider ??
    (options.browser === undefined ? undefined : HostedBrowserProvider.make(options.browser));
  const now = options.now ?? Clock.currentTimeMillis;
  const putTask = (task: Task) => boundary(() => options.storage.put(taskKey(task.taskId), task));
  const owned = (task: Task) =>
    task.ownerUserId === options.ownerUserId && task.hostSessionId === options.hostSessionId;
  const readTask = Effect.fn("HostedBrowser.readTask")(function* (taskId: string) {
    const raw = yield* boundary(() => options.storage.get(taskKey(taskId)));
    const task = yield* decode(Task, raw);
    if (!owned(task)) return yield* unavailable();
    if (task.pendingOperationId === null || task.closed) return task;
    const pending = yield* boundary(() =>
      options.storage.get(operationKey(taskId, task.pendingOperationId ?? "")),
    );
    if (pending === undefined) return task;
    const operation = yield* decode(Operation, pending);
    if (operation.outcome === null) return task;
    const recovered = {
      ...task,
      pendingOperationId: null,
      observation: operation.outcome._tag === "Observed" ? operation.outcome.observation : null,
    };
    yield* putTask(recovered);
    return recovered;
  });
  const tasks = Effect.fn("HostedBrowser.tasks")(function* () {
    const rows = yield* boundary(() => options.storage.list({ prefix: "hosted-browser:task:" }));
    const decoded = yield* Effect.forEach(Array.from(rows.values()), (raw) => decode(Task, raw));
    if (decoded.some((task) => !owned(task))) return yield* unavailable();
    return decoded;
  });
  const available = Effect.fn("HostedBrowser.available")(function* () {
    if (
      provider === undefined ||
      (yield* boundary(() => options.storage.get("hosted-browser:revoked"))) !== undefined
    )
      return yield* unavailable();
    return provider;
  });
  const closeTask = Effect.fn("HostedBrowser.closeTask")(function* (task: Task) {
    if (task.closed) return undefined;
    if (task.sessionId !== null) {
      if (provider === undefined) return yield* unavailable();
      // A failed deletion keeps the ID available for the next cleanup attempt.
      yield* provider.close(task.sessionId);
    } else if (task.creationDispatched && task.orphanExpiresAt > (yield* now)) {
      // No target or Live View can exist before a session ID is retained. An uncertain
      // create has only the provider's bounded idle lifetime, plus the request tail.
      return yield* unavailable();
    }
    if (options.usage !== undefined)
      yield* task.creationDispatched
        ? options.usage.close(task.taskId)
        : options.usage.cancel(task.taskId);
    const prefix = `hosted-browser:operation:${encodeIdentity([task.taskId]).slice(0, -1)},`;
    const records = yield* boundary(() => options.storage.list({ prefix }));
    yield* Effect.forEach(
      Array.from(records.keys()),
      (key) => boundary(() => options.storage.delete(key)),
      { concurrency: 1 },
    );
    yield* putTask({
      ...task,
      closed: true,
      paused: false,
      handoffId: null,
      pendingOperationId: null,
      observation: null,
    });
    return undefined;
  });
  const sweepUnlocked = Effect.fn("HostedBrowser.sweep")(function* () {
    const time = yield* now;
    const expired = (yield* tasks()).filter(
      (task) =>
        !task.closed &&
        (task.sessionId === null && task.creationDispatched
          ? task.orphanExpiresAt
          : task.expiresAt) <= time,
    );
    yield* Effect.forEach(expired, closeTask, { concurrency: 1 });
  });
  const revokeUnlocked = Effect.fn("HostedBrowser.quiesce")(function* () {
    yield* boundary(() => options.storage.put("hosted-browser:revoked", true));
    yield* Effect.forEach(yield* tasks(), closeTask, { concurrency: 1 });
  });
  const executeUnlocked = Effect.fn("HostedBrowser.execute")(function* (
    input: BrowserRequest,
  ): Effect.fn.Return<BrowserOutcome, HostedBrowserProvider.Unavailable> {
    const request = yield* decode(BrowserRequest, input);
    if (
      request.ownerUserId !== options.ownerUserId ||
      request.hostSessionId !== options.hostSessionId
    )
      return yield* unavailable();
    if (request.command._tag === "Revoke") {
      yield* revokeUnlocked();
      return { _tag: "Closed" };
    }
    const runtime = yield* available();
    const key = operationKey(request.taskId, request.operationId);
    const body = encodeBrowserRequest(request);
    const prior = yield* boundary(() => options.storage.get(key));
    if (prior !== undefined) {
      const operation = yield* decode(Operation, prior);
      return operation.request === body
        ? (operation.outcome ?? { _tag: "Unknown" })
        : { _tag: "Conflict" };
    }
    if (request.command._tag === "Outcome") {
      const priorOutcome = yield* boundary(() =>
        options.storage.get(
          operationKey(
            request.taskId,
            request.command._tag === "Outcome" ? request.command.operationId : "",
          ),
        ),
      );
      return priorOutcome === undefined
        ? { _tag: "Unknown" }
        : ((yield* decode(Operation, priorOutcome)).outcome ?? { _tag: "Unknown" });
    }
    const operations = yield* boundary(() =>
      options.storage.list({ prefix: "hosted-browser:operation:" }),
    );
    if (request.command._tag !== "Close" && operations.size >= 1024) return { _tag: "Unavailable" };
    const time = yield* now;
    const raw = yield* boundary(() => options.storage.get(taskKey(request.taskId)));
    const command = request.command;
    if (command._tag === "Open") {
      if (raw !== undefined) return { _tag: "Conflict" };
      const url = URL.parse(command.url);
      if (
        url === null ||
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        !isPublicHostname(url.hostname)
      )
        return { _tag: "Unavailable" };
      yield* sweepUnlocked();
      if ((yield* tasks()).filter((task) => !task.closed).length >= 1)
        return { _tag: "Unavailable" };
      const task: Task = {
        taskId: request.taskId,
        ownerUserId: request.ownerUserId,
        hostSessionId: request.hostSessionId,
        origin: url.origin,
        sessionId: null,
        targetId: null,
        expiresAt: time + taskLifetimeMilliseconds,
        orphanExpiresAt: time + orphanLifetimeMilliseconds,
        creationDispatched: false,
        handoffId: null,
        closed: false,
        paused: false,
        pendingOperationId: request.operationId,
        observation: null,
      };
      yield* boundary(() => options.storage.put(key, { request: body, outcome: null }));
      yield* putTask(task);
      return yield* Effect.gen(function* () {
        if (options.usage !== undefined) yield* options.usage.start(request);
        const dispatched = { ...task, creationDispatched: true };
        yield* putTask(dispatched);
        const sessionId = yield* runtime.create;
        const retained = { ...dispatched, sessionId };
        yield* putTask(retained);
        const opened = yield* runtime.open(sessionId, url.href);
        const observation = {
          ...opened.page,
          taskId: request.taskId,
          observationId: request.operationId,
          observedAt: time,
        };
        const outcome = { _tag: "Observed", observation } as const;
        const observedTask = { ...retained, targetId: opened.targetId, observation };
        yield* putTask(observedTask);
        if (options.usage !== undefined) yield* options.usage.observed(task.taskId);
        yield* boundary(() => options.storage.put(key, { request: body, outcome }));
        yield* putTask({ ...observedTask, pendingOperationId: null });
        return outcome;
      }).pipe(Effect.orElseSucceed(() => ({ _tag: "Unknown" }) as const));
    }
    if (raw === undefined) return { _tag: "Unavailable" };
    const task = yield* readTask(request.taskId);
    if (command._tag === "Close") {
      yield* closeTask(task);
      return { _tag: "Closed" };
    }
    if (task.closed || task.expiresAt <= time || task.sessionId === null || task.targetId === null)
      return { _tag: "Unavailable" };
    if (task.paused) return { _tag: "HumanRequired" };
    if (task.pendingOperationId !== null) return { _tag: "Unknown" };
    if (
      command._tag === "Interact" &&
      (task.observation === null ||
        task.observation.observationId !== command.observationId ||
        task.observation.observedAt + 300_000 <= time)
    )
      return { _tag: "Stale" };
    const sessionId = task.sessionId;
    const targetId = task.targetId;
    const expected = task.observation;
    yield* boundary(() => options.storage.put(key, { request: body, outcome: null }));
    yield* putTask({ ...task, pendingOperationId: request.operationId });
    return yield* Effect.gen(function* () {
      const result =
        command._tag === "Observe"
          ? yield* runtime.observe(sessionId, targetId, task.origin)
          : command._tag === "Interact" && expected !== null
            ? yield* runtime.interact(
                sessionId,
                targetId,
                task.origin,
                expected,
                command.interaction,
              )
            : yield* unavailable();
      const outcome: BrowserOutcome =
        "_tag" in result
          ? result
          : {
              _tag: "Observed",
              observation: {
                ...result,
                taskId: task.taskId,
                observationId: request.operationId,
                observedAt: time,
              },
            };
      yield* boundary(() => options.storage.put(key, { request: body, outcome }));
      yield* putTask({
        ...task,
        pendingOperationId: null,
        observation: outcome._tag === "Observed" ? outcome.observation : null,
      });
      return outcome;
    }).pipe(Effect.orElseSucceed(() => ({ _tag: "Unknown" }) as const));
  });
  return {
    execute: (request: BrowserRequest) => run(executeUnlocked(request)),
    inspect: (request: InventoryRequest) =>
      run(
        Effect.gen(function* (): Effect.fn.Return<
          InventoryResponse["outcome"],
          HostedBrowserProvider.Unavailable
        > {
          if (
            request.ownerUserId !== options.ownerUserId ||
            request.hostSessionId !== options.hostSessionId
          )
            return yield* unavailable();
          yield* available();
          yield* sweepUnlocked();
          const active = (yield* tasks()).filter((task) => !task.closed && task.targetId !== null);
          return {
            _tag: "Observed",
            observedAt: yield* now,
            browsers: [
              { id: options.hostSessionId, name: "Hosted browser", tabCount: active.length },
            ],
          };
        }),
      ),
    list: () =>
      run(
        Effect.gen(function* () {
          yield* available();
          yield* sweepUnlocked();
          return (yield* tasks())
            .filter((task) => !task.closed)
            .map((task) => ({
              taskId: task.taskId,
              url: task.observation?.url ?? task.origin,
              state: task.paused ? ("human" as const) : ("active" as const),
            }));
        }),
      ),
    nextExpiry: () =>
      run(
        Effect.gen(function* () {
          const deadlines = (yield* tasks())
            .filter((task) => !task.closed)
            .map((task) =>
              task.sessionId === null && task.creationDispatched
                ? task.orphanExpiresAt
                : task.expiresAt,
            );
          return deadlines.length === 0 ? null : Math.min(...deadlines);
        }),
      ),
    quiesce: run(revokeUnlocked()),
    sweep: run(sweepUnlocked()),
    liveView: (taskId: string) =>
      run(
        Effect.gen(function* () {
          const runtime = yield* available();
          const task = yield* readTask(taskId);
          if (
            task.closed ||
            task.expiresAt <= (yield* now) ||
            task.pendingOperationId !== null ||
            task.sessionId === null ||
            task.targetId === null
          )
            return yield* unavailable();
          yield* putTask({ ...task, paused: true, handoffId: null, observation: null });
          const view = yield* runtime.liveView(task.sessionId, task.targetId);
          yield* putTask({ ...task, paused: true, handoffId: view.handoffId, observation: null });
          return { url: view.url, expiresInMs: view.expiresInMs };
        }),
      ),
    resume: (taskId: string) =>
      run(
        Effect.gen(function* () {
          const runtime = yield* available();
          const task = yield* readTask(taskId);
          if (
            task.closed ||
            task.expiresAt <= (yield* now) ||
            task.pendingOperationId !== null ||
            task.sessionId === null ||
            task.targetId === null ||
            task.handoffId === null ||
            !task.paused
          )
            return yield* unavailable();
          yield* runtime.resume(task.sessionId, task.targetId, task.handoffId);
          yield* putTask({ ...task, paused: false, handoffId: null, observation: null });
          return undefined;
        }),
      ),
  };
};

export * as HostedBrowser from "./hosted-browser";

const isPublicHostname = (hostname: string): boolean =>
  hostname.includes(".") &&
  !hostname.startsWith("[") &&
  !/^\d+\.\d+\.\d+\.\d+$/.test(hostname) &&
  !["localhost", "local", "internal"].some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
