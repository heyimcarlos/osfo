/* oxlint-disable eslint/no-underscore-dangle -- Browser outcomes use the canonical wire discriminator. */
/* oxlint-disable vitest/no-standalone-expect -- Effect Vitest it.effect callbacks are test bodies. */
/* oxlint-disable osfo/no-unknown-parameters -- The fake implements the durable storage trust boundary. */
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import type { BrowserRequest } from "@osfo/api/browser-host";
import { HostedBrowser } from "./hosted-browser";

const open: BrowserRequest = {
  ownerUserId: "owner-a",
  hostSessionId: "hosted:agent-a",
  taskId: "task",
  operationId: "open",
  turnId: "turn",
  command: { _tag: "Open", url: "https://portal.example/form" },
};
const request = (operationId: string, command: BrowserRequest["command"]): BrowserRequest => ({
  ...open,
  operationId,
  command,
});
const storage = () => {
  const rows = new Map<string, unknown>();
  return {
    rows,
    delete: (key: string) => Promise.resolve(rows.delete(key)),
    get: (key: string) => Promise.resolve(rows.get(key)),
    put: (key: string, value: unknown) => {
      rows.set(key, structuredClone(value));
      return Promise.resolve();
    },
    list: ({ prefix }: { readonly prefix: string }) =>
      Promise.resolve(new Map(Array.from(rows).filter(([key]) => key.startsWith(prefix)))),
  };
};
const fixture = Effect.gen(function* () {
  const state = storage();
  const time = yield* Ref.make(1000);
  const effects = yield* Ref.make(0);
  const closes = yield* Ref.make(0);
  const uncertain = yield* Ref.make(false);
  const failClose = yield* Ref.make(false);
  const handoffActive = yield* Ref.make(true);
  const page = {
    url: open.command._tag === "Open" ? open.command.url : "",
    text: "7 button Submit",
  };
  const provider: HostedBrowser.Provider = {
    create: Effect.succeed("session-a"),
    open: () => Effect.succeed({ targetId: "target-a", page }),
    observe: () => Effect.succeed(page),
    interact: () =>
      Effect.gen(function* () {
        yield* Ref.update(effects, (count) => count + 1);
        if (yield* Ref.get(uncertain))
          return yield* new HostedBrowser.Unavailable({ message: "lost reply" });
        return page;
      }),
    close: () =>
      Effect.gen(function* () {
        yield* Ref.update(closes, (count) => count + 1);
        if (yield* Ref.get(failClose))
          return yield* new HostedBrowser.Unavailable({ message: "delete failed" });
        return undefined;
      }),
    resume: () =>
      Ref.get(handoffActive).pipe(
        Effect.flatMap((active) =>
          active
            ? Effect.fail(new HostedBrowser.Unavailable({ message: "handoff active" }))
            : Effect.void,
        ),
      ),
    liveView: () =>
      Effect.succeed({
        url: "https://live.browser.run/?token=test",
        expiresInMs: 300000,
        handoffId: "handoff-test",
      }),
  };
  const make = () =>
    HostedBrowser.make({
      storage: state,
      provider,
      ownerUserId: open.ownerUserId,
      hostSessionId: open.hostSessionId,
      now: Ref.get(time),
    });
  return { state, time, effects, closes, uncertain, failClose, handoffActive, make, provider };
});
const click = request("click", {
  _tag: "Interact",
  observationId: "open",
  interaction: { _tag: "Click", target: "7" },
});

describe("hosted browser ownership and durable dispatch", () => {
  it.effect(
    "rejects another owner and private initial destinations before creating a session",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const browser = f.make();
        expect(
          (yield* Effect.flip(browser.execute({ ...open, ownerUserId: "owner-b" })))._tag,
        ).toBe("HostedBrowserUnavailable");
        for (const url of [
          "https://127.0.0.1/",
          "https://10.0.0.1/",
          "https://[::1]/",
          "https://thing.local/",
          "https://localhost./",
          "https://thing.local./",
          "https://service.internal.:8443/",
          "https://user:password@portal.example/",
          "http://portal.example/",
        ]) {
          expect(yield* browser.execute({ ...open, command: { _tag: "Open", url } })).toEqual({
            _tag: "Unavailable",
          });
        }
        expect(f.state.rows.size).toBe(0);
      }),
  );

  it.effect(
    "replays an acknowledged operation after reconstruction without repeating the interaction",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.make().execute(open);
        const first = yield* f.make().execute(click);
        expect(first._tag).toBe("Observed");
        expect(yield* f.make().execute(click)).toEqual(first);
        expect(yield* Ref.get(f.effects)).toBe(1);
        expect(yield* f.make().execute({ ...click, command: { _tag: "Observe" } })).toEqual({
          _tag: "Conflict",
        });
      }),
  );

  it.effect("retains a lost interaction response and blocks another dispatch", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.make().execute(open);
      yield* Ref.set(f.uncertain, true);
      expect(yield* f.make().execute(click)).toEqual({ _tag: "Unknown" });
      yield* Ref.set(f.uncertain, false);
      expect(yield* f.make().execute(click)).toEqual({ _tag: "Unknown" });
      expect(yield* f.make().execute({ ...click, operationId: "another-click" })).toEqual({
        _tag: "Unknown",
      });
      expect(yield* Ref.get(f.effects)).toBe(1);
    }),
  );

  it.effect("expires observations independently of the provider session", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.make().execute(open);
      yield* Ref.set(f.time, 301000);
      expect(yield* f.make().execute(click)).toEqual({ _tag: "Stale" });
      expect(yield* Ref.get(f.effects)).toBe(0);
    }),
  );

  it.effect("retains failed deletion obligations and refuses new work after revocation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.make().execute(open);
      yield* Ref.set(f.failClose, true);
      yield* Effect.flip(f.make().quiesce);
      expect(
        (yield* Effect.flip(f.make().execute(request("observe", { _tag: "Observe" }))))._tag,
      ).toBe("HostedBrowserUnavailable");
      yield* Ref.set(f.failClose, false);
      yield* f.make().quiesce;
      expect(yield* Ref.get(f.closes)).toBe(2);
      yield* f.make().quiesce;
      expect(yield* Ref.get(f.closes)).toBe(2);
    }),
  );

  it.effect("sweeps expired physical sessions and hides them from the owned task list", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.make().execute(open);
      yield* Ref.set(f.time, 3601000);
      yield* f.make().sweep;
      expect(yield* Ref.get(f.closes)).toBe(1);
      expect(yield* f.make().list()).toEqual([]);
    }),
  );

  it.effect(
    "pauses before exposing human access and never unlocks solely because its URL expired",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.make().execute(open);
        yield* f.make().liveView("task");
        expect(yield* f.make().execute(click)).toEqual({ _tag: "HumanRequired" });
        yield* Ref.set(f.time, 401000);
        yield* Effect.flip(f.make().resume("task"));
        expect(yield* f.make().execute(request("read", { _tag: "Observe" }))).toEqual({
          _tag: "HumanRequired",
        });
      }),
  );
  it.effect("recovers a retained result after interruption before clearing the task claim", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.make().execute(open);
      const put = f.state.put;
      f.state.put = (key, value) =>
        key.startsWith("hosted-browser:task:") &&
        Option.isSome(
          Schema.decodeUnknownOption(Schema.Struct({ pendingOperationId: Schema.Null }))(value),
        )
          ? Promise.reject(new Error("interrupted final task write"))
          : put(key, value);
      expect(yield* f.make().execute(click)).toEqual({ _tag: "Unknown" });
      f.state.put = put;
      expect((yield* f.make().execute(request("observe-after", { _tag: "Observe" })))._tag).toBe(
        "Observed",
      );
      expect(yield* Ref.get(f.effects)).toBe(1);
    }),
  );

  it.effect("resolves an unidentified create only after the bounded orphan lifetime", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const make = () =>
        HostedBrowser.make({
          storage: f.state,
          ownerUserId: open.ownerUserId,
          hostSessionId: open.hostSessionId,
          now: Ref.get(f.time),
          provider: {
            ...f.provider,
            create: Effect.fail(new HostedBrowser.Unavailable({ message: "create reply lost" })),
          },
        });
      expect(yield* make().execute(open)).toEqual({ _tag: "Unknown" });
      expect(yield* make().nextExpiry()).toBe(1201000);
      yield* Effect.flip(make().quiesce);
      yield* Ref.set(f.time, 1201000);
      yield* make().quiesce;
      expect(yield* Ref.get(f.closes)).toBe(0);
      expect(yield* make().nextExpiry()).toBeNull();
    }),
  );

  it.effect("does not retain a physical cleanup obligation when admission refused creation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const make = () =>
        HostedBrowser.make({
          storage: f.state,
          ownerUserId: open.ownerUserId,
          hostSessionId: open.hostSessionId,
          now: Ref.get(f.time),
          provider: f.provider,
          usage: {
            observed: () => Effect.void,
            cancel: () => Effect.void,
            start: () => Effect.fail(new HostedBrowser.Unavailable({ message: "no allowance" })),
            close: () => Effect.die(new Error("nothing dispatched")),
          },
        });
      expect(yield* make().execute(open)).toEqual({ _tag: "Unknown" });
      yield* make().quiesce;
      expect(yield* Ref.get(f.closes)).toBe(0);
    }),
  );

  it.effect("permits idempotent physical close when the operation ledger is full", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.make().execute(open);
      for (let index = 0; index < 1024; index++)
        f.state.rows.set(`hosted-browser:operation:full-${index}`, null);
      expect(yield* f.make().execute(request("close", { _tag: "Close" }))).toEqual({
        _tag: "Closed",
      });
      expect(yield* Ref.get(f.closes)).toBe(1);
      expect(yield* f.make().execute(click)).toEqual({ _tag: "Unavailable" });
    }),
  );

  it.effect("resumes only after provider handoff completion and requires a fresh observation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.make().execute(open);
      yield* f.make().liveView("task");
      yield* Effect.flip(f.make().resume("task"));
      yield* Ref.set(f.handoffActive, false);
      yield* f.make().resume("task");
      expect(yield* f.make().execute(click)).toEqual({ _tag: "Stale" });
      expect((yield* f.make().execute(request("fresh", { _tag: "Observe" })))._tag).toBe(
        "Observed",
      );
    }),
  );
  it.effect(
    "keeps the owner slot occupied until usage settlement succeeds after physical deletion",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const failSettlement = yield* Ref.make(true);
        const make = () =>
          HostedBrowser.make({
            storage: f.state,
            ownerUserId: open.ownerUserId,
            hostSessionId: open.hostSessionId,
            now: Ref.get(f.time),
            provider: f.provider,
            usage: {
              observed: () => Effect.void,
              cancel: () => Effect.void,
              start: () => Effect.void,
              close: () =>
                Ref.get(failSettlement).pipe(
                  Effect.flatMap((failed) =>
                    failed
                      ? Effect.fail(
                          new HostedBrowser.Unavailable({ message: "settlement unavailable" }),
                        )
                      : Effect.void,
                  ),
                ),
            },
          });
        yield* make().execute(open);
        yield* Effect.flip(make().execute(request("close", { _tag: "Close" })));
        const next = { ...open, taskId: "second", operationId: "second" };
        expect(yield* make().execute(next)).toEqual({ _tag: "Unavailable" });
        yield* Ref.set(failSettlement, false);
        yield* make().execute(request("retry-close", { _tag: "Close" }));
        expect((yield* make().execute(next))._tag).toBe("Observed");
      }),
  );
  it.effect("bounds a stalled create and releases the lock while retaining its unknown claim", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const started = yield* Deferred.make<void>();
      const make = () =>
        HostedBrowser.make({
          storage: f.state,
          provider: {
            ...f.provider,
            create: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          },
          ownerUserId: open.ownerUserId,
          hostSessionId: open.hostSessionId,
          now: Ref.get(f.time),
        });
      const creation = yield* make().execute(open).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(started);
      yield* TestClock.adjust("25 seconds");
      expect((yield* Fiber.join(creation))._tag).toBe("Failure");
      expect(yield* make().execute(open)).toEqual({ _tag: "Unknown" });
      yield* Ref.set(f.time, 1201000);
      yield* make().quiesce;
      expect(yield* make().nextExpiry()).toBeNull();
    }),
  );

  it.effect("bounds a stalled cleanup and lets a later attempt confirm deletion", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.make().execute(open);
      yield* Ref.set(f.time, 601000);
      const started = yield* Deferred.make<void>();
      const blocked = HostedBrowser.make({
        storage: f.state,
        provider: {
          ...f.provider,
          close: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        },
        ownerUserId: open.ownerUserId,
        hostSessionId: open.hostSessionId,
        now: Ref.get(f.time),
      });
      const cleanup = yield* blocked.sweep.pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(started);
      yield* TestClock.adjust("25 seconds");
      expect((yield* Fiber.join(cleanup))._tag).toBe("Failure");
      yield* f.make().sweep;
      expect(yield* Ref.get(f.closes)).toBe(1);
    }),
  );
});
