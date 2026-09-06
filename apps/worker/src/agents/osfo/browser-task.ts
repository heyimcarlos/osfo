/* oxlint-disable eslint/no-underscore-dangle -- Browser wire outcomes use the canonical _tag discriminator. */
import {
  BrowserInteraction,
  BrowserObservation,
  BrowserOutcome,
  BrowserRequest,
  type BrowserCommand,
} from "@osfo/api/browser-host";
import { Clock, Effect, Schema, Semaphore } from "effect";

import { UserId } from "../../domain";
import { Browser } from "../../services/browser-host";

const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
export const BrowserTaskInput = Schema.Struct({ taskId: identity });
export const BrowserOpenInput = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
});
export const BrowserEffectInput = Schema.Struct({
  taskId: identity,
  observationId: identity,
  expectedUrl: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  targetDescription: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  interaction: BrowserInteraction,
  consequence: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export type BrowserEffectInput = typeof BrowserEffectInput.Type;

/** Bind the visible destination and target description to the retained page, not model claims. */
export const matchesObservation = (task: Task, input: BrowserEffectInput): boolean =>
  task.observation?.observationId === input.observationId &&
  task.observation.url === input.expectedUrl &&
  /^\d+$/.test(input.interaction.target) &&
  task.observation.text
    .split("\n")
    .some(
      (line) =>
        line.trim() === input.targetDescription &&
        line.trim().startsWith(`${input.interaction.target} `),
    );

const Task = Schema.Struct({
  taskId: identity,
  userId: UserId,
  hostSessionId: identity,
  requestText: Schema.String,
  startUrl: Schema.String,
  closed: Schema.Boolean,
  observation: Schema.NullOr(BrowserObservation),
  lastRequest: BrowserRequest,
  lastOutcome: Schema.NullOr(BrowserOutcome),
  uncertainOperationId: Schema.NullOr(identity),
});
export type Task = typeof Task.Type;
const encodeTask = Schema.encodeSync(Task);

export interface Options {
  readonly cleanup: (userId: UserId) => Effect.Effect<void, Browser.BrowserUnavailable>;
  readonly storage: DurableObjectStorage;
  readonly binding: (userId: UserId) => Browser.Binding | null;
  readonly now?: Effect.Effect<number>;
  readonly authorize: (
    request: Browser.Inspection,
    command: BrowserCommand,
  ) => Effect.Effect<void, Browser.BrowserUnavailable>;
  readonly dispatch: (
    request: BrowserRequest,
    binding: Browser.Binding,
  ) => Effect.Effect<BrowserOutcome, Browser.BrowserUnavailable>;
}

/** Agent-owned task intent and evidence survive Session changes; the host owns physical dispatch. */
export const make = (options: Options) => {
  const lock = Semaphore.makeUnsafe(1);
  const retain = (task: Task) =>
    Effect.tryPromise({
      try: () => options.storage.put(`browser-task:${task.taskId}`, encodeTask(task)),
      catch: unavailable,
    });
  const read = Effect.fn("BrowserTask.read")(function* (taskId: string, userId: UserId) {
    const raw = yield* Effect.tryPromise({
      try: () => options.storage.get(`browser-task:${taskId}`),
      catch: unavailable,
    });
    const task = yield* Schema.decodeUnknownEffect(Task)(raw).pipe(Effect.mapError(unavailable));
    if (task.userId !== userId || task.hostSessionId !== options.binding(userId)?.hostSessionId)
      return yield* unavailable();
    const now = yield* options.now ?? Clock.currentTimeMillis;
    return expireObservation(task, now);
  });
  const dispatch = Effect.fn("BrowserTask.dispatch")(function* (
    inspection: Browser.Inspection,
    task: Task,
    command: BrowserCommand,
  ) {
    const binding = options.binding(inspection.userId);
    if (binding === null || !Browser.isAvailable(binding, inspection.userId))
      return yield* unavailable();
    yield* options.authorize(inspection, command);
    const request: BrowserRequest = {
      ownerUserId: inspection.userId,
      hostSessionId: binding.hostSessionId,
      operationId: inspection.operationId,
      turnId: inspection.turnId,
      taskId: task.taskId,
      command,
    };
    yield* retain({
      ...task,
      lastRequest: request,
      lastOutcome: null,
      uncertainOperationId:
        command._tag === "Interact" ? inspection.operationId : task.uncertainOperationId,
    });
    const outcome = yield* options
      .dispatch(request, binding)
      .pipe(Effect.orElseSucceed(() => ({ _tag: "Unknown" }) as const));
    const completed = {
      ...task,
      observation: outcome._tag === "Observed" ? outcome.observation : task.observation,
      closed: outcome._tag === "Closed" || task.closed,
      lastRequest: request,
      lastOutcome: outcome,
      uncertainOperationId:
        command._tag === "Interact" && outcome._tag === "Unknown"
          ? inspection.operationId
          : command._tag === "Outcome" &&
              command.operationId === task.uncertainOperationId &&
              outcome._tag === "Observed"
            ? null
            : task.uncertainOperationId,
    };
    yield* retain(completed);
    return completed;
  });
  return {
    open: Effect.fn("BrowserTask.open")(function* (
      inspection: Browser.Inspection,
      url: string,
      requestText: string,
    ) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const binding = options.binding(inspection.userId);
          if (binding === null || !Browser.isAvailable(binding, inspection.userId))
            return yield* unavailable();
          // Opening authority comes from the actual User request, never a page or model-provided scope.
          if (
            !URL.canParse(url) ||
            new URL(url).protocol !== "https:" ||
            new URL(url).username !== "" ||
            new URL(url).password !== "" ||
            !matchesSuppliedBrowserUrl(requestText, url)
          )
            return yield* unavailable();
          const command = { _tag: "Open", url: new URL(url).href } as const;
          yield* options.authorize(inspection, command);
          const existing = yield* Effect.tryPromise({
            try: () => options.storage.get(`browser-task:${inspection.operationId}`),
            catch: unavailable,
          });
          if (existing !== undefined) {
            const task = yield* read(inspection.operationId, inspection.userId);
            if (task.startUrl !== command.url) return yield* unavailable();
            return task;
          }
          const request: BrowserRequest = {
            ownerUserId: inspection.userId,
            hostSessionId: binding.hostSessionId,
            taskId: inspection.operationId,
            operationId: inspection.operationId,
            turnId: inspection.turnId,
            command,
          };
          return yield* dispatch(
            inspection,
            {
              taskId: inspection.operationId,
              userId: inspection.userId,
              hostSessionId: binding.hostSessionId,
              requestText: requestText.slice(0, 16_000),
              startUrl: command.url,
              closed: false,
              observation: null,
              lastRequest: request,
              lastOutcome: null,
              uncertainOperationId: null,
            },
            command,
          );
        }),
      );
    }),
    run: Effect.fn("BrowserTask.run")(function* (
      inspection: Browser.Inspection,
      taskId: string,
      command: Exclude<BrowserCommand, { readonly _tag: "Open" | "Revoke" }>,
    ) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const task = yield* read(taskId, inspection.userId);
          if (task.closed && command._tag !== "Outcome") return yield* unavailable();
          if (command._tag === "Interact") {
            if (
              task.observation?.observationId !== command.observationId ||
              task.lastOutcome === null ||
              task.uncertainOperationId !== null
            )
              return yield* unavailable();
          }
          return yield* dispatch(inspection, task, command);
        }),
      );
    }),
    list: Effect.fn("BrowserTask.list")(function* (inspection: Browser.Inspection) {
      yield* options.authorize(inspection, {
        _tag: "Outcome",
        operationId: inspection.operationId,
      });
      const rows = yield* Effect.tryPromise({
        try: () => options.storage.list({ prefix: "browser-task:", limit: 100 }),
        catch: unavailable,
      });
      const tasks = yield* Effect.forEach(Array.from(rows.values()), (value) =>
        Schema.decodeUnknownEffect(Task)(value).pipe(Effect.mapError(unavailable)),
      );
      const now = yield* options.now ?? Clock.currentTimeMillis;
      const owned = tasks
        .filter((task) => task.userId === inspection.userId)
        .map((task) => expireObservation(task, now));
      return [...owned.filter((task) => !task.closed), ...owned.filter((task) => task.closed)]
        .slice(0, 4)
        .map((task) => ({
          taskId: task.taskId,
          requestText: task.requestText,
          startUrl: task.startUrl,
          closed: task.closed,
          observation:
            task.observation === null
              ? null
              : {
                  observationId: task.observation.observationId,
                  url: task.observation.url,
                  observedAt: task.observation.observedAt,
                },
          lastOutcome: task.lastOutcome?._tag ?? null,
          lastOperationId: task.lastRequest.operationId,
          uncertainOperationId: task.uncertainOperationId,
        }));
    }),
    read,
    invalidateObservation: Effect.fn("BrowserTask.invalidateObservation")(function* (
      taskId: string,
      userId: UserId,
    ) {
      yield* lock.withPermit(
        Effect.gen(function* () {
          const task = yield* read(taskId, userId);
          if (task.closed) return yield* unavailable();
          return yield* retain({ ...task, observation: null });
        }),
      );
    }),
    quiesce: Effect.fn("BrowserTask.quiesce")(function* (userId: UserId) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const rows = yield* Effect.tryPromise({
            try: () => options.storage.list({ prefix: "browser-task:" }),
            catch: unavailable,
          });
          const tasks = yield* Effect.forEach(Array.from(rows.values()), (value) =>
            Schema.decodeUnknownEffect(Task)(value).pipe(Effect.mapError(unavailable)),
          );
          if (tasks.some((task) => task.userId !== userId)) return yield* unavailable();
          yield* options.cleanup(userId);
          if (rows.size === 0) return undefined;
          yield* Effect.tryPromise({
            try: () => options.storage.delete(Array.from(rows.keys())),
            catch: unavailable,
          });
          return undefined;
        }),
      );
    }),
  };
};

const unavailable = () =>
  new Browser.BrowserUnavailable({
    message: "The owned browser task is unavailable or requires a fresh observation.",
  });

const expireObservation = (task: Task, now: number): Task =>
  task.observation !== null &&
  (task.observation.observedAt > now || now - task.observation.observedAt >= 5 * 60_000)
    ? { ...task, observation: null }
    : task;

export * as BrowserTask from "./browser-task";

/** Preserve exact URLs; a single prose terminator may follow the requested URL. */
export const matchesSuppliedBrowserUrl = (requestText: string, requestedUrl: string): boolean => {
  if (!URL.canParse(requestedUrl)) return false;
  const expected = new URL(requestedUrl).href;
  const supplied = requestText.match(/https?:\/\/[^\s<>"']+/g) ?? [];
  const matches = (value: string) => URL.canParse(value) && new URL(value).href === expected;
  if (supplied.some(matches)) return true;
  return supplied.some((value) => /[.,;!]$/u.test(value) && matches(value.slice(0, -1)));
};
