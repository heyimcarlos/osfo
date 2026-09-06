/* oxlint-disable eslint/no-underscore-dangle -- Browser wire outcomes use the canonical _tag discriminator. */
/* oxlint-disable effecttsgo/node-builtin-import -- These tests own an isolated real SQLite ledger. */
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "@effect/vitest";
import type { BrowserRequest } from "@osfo/api/browser-host";
import { Effect } from "effect";

import { BrowserTask } from "./browser-task.ts";

const request: BrowserRequest = {
  ownerUserId: "owner",
  hostSessionId: "extension",
  turnId: "turn",
  operationId: "open",
  taskId: "task",
  command: { _tag: "Open", url: "https://portal.example.test/appointments" },
};

const database = Effect.acquireRelease(
  Effect.sync(() => new DatabaseSync(":memory:")),
  (resource) => Effect.sync(() => resource.close()),
);

it.effect("retains one protected interaction and rejects changed replay and stale evidence", () =>
  Effect.gen(function* () {
    const db = yield* database;
    let calls = 0;
    const page = {
      url: request.command._tag === "Open" ? request.command.url : "",
      text: "Select a service",
    };
    const runtime: BrowserTask.Runtime = {
      closeAll: Effect.succeed(true),
      open: () => Effect.succeed({ _tag: "Opened", tabId: "owned-tab", page }),
      observe: () => Effect.succeed({ _tag: "Page", page }),
      interact: () =>
        Effect.sync(() => {
          calls += 1;
          return { _tag: "Page", page: { ...page, text: "Appointment confirmed: SYNTHETIC-1" } };
        }),
      close: () => Effect.succeed(true),
    };
    const execute = BrowserTask.make(db, runtime, ["https://portal.example.test"]).execute;
    expect(yield* execute(request)).toMatchObject({
      _tag: "Observed",
      observation: { observationId: "open" },
    });
    const submit: BrowserRequest = {
      ...request,
      operationId: "submit",
      command: {
        _tag: "Interact",
        observationId: "open",
        interaction: { _tag: "Click", target: "confirm" },
      },
    };
    const first = yield* execute(submit);
    expect(yield* execute(submit)).toEqual(first);
    expect(
      yield* execute({
        ...submit,
        command: {
          _tag: "Interact",
          observationId: "open",
          interaction: { _tag: "Click", target: "cancel" },
        },
      }),
    ).toEqual({ _tag: "Conflict" });
    expect(yield* execute({ ...submit, operationId: "stale" })).toEqual({ _tag: "Stale" });
    expect(calls).toBe(1);
    expect(
      yield* execute({
        ...request,
        operationId: "recover",
        turnId: "later-turn",
        command: { _tag: "Outcome", operationId: "submit" },
      }),
    ).toEqual(first);
  }),
);

it.effect("never repeats an interrupted dispatch after reconnecting to its retained ledger", () =>
  Effect.gen(function* () {
    const db = yield* database;
    let calls = 0;
    const page = { url: "https://portal.example.test/appointments", text: "Confirm" };
    const runtime: BrowserTask.Runtime = {
      closeAll: Effect.succeed(true),
      open: () => Effect.succeed({ _tag: "Opened", tabId: "owned-tab", page }),
      observe: () => Effect.succeed({ _tag: "Page", page }),
      interact: () =>
        Effect.sync(() => {
          calls += 1;
        }).pipe(Effect.andThen(Effect.die(new Error("lost response after submit")))),
      close: () => Effect.succeed(true),
    };
    const first = BrowserTask.make(db, runtime, ["https://portal.example.test"]).execute;
    yield* first(request);
    const submit: BrowserRequest = {
      ...request,
      operationId: "submit",
      command: {
        _tag: "Interact",
        observationId: "open",
        interaction: { _tag: "Click", target: "confirm" },
      },
    };
    yield* Effect.exit(first(submit));
    const restarted = BrowserTask.make(db, runtime, ["https://portal.example.test"]).execute;
    expect(yield* restarted(submit)).toEqual({ _tag: "Unknown" });
    expect(calls).toBe(1);
  }),
);

it.effect("refuses unprovisioned origins before opening any browser", () =>
  Effect.gen(function* () {
    const db = yield* database;
    const runtime: BrowserTask.Runtime = {
      closeAll: Effect.succeed(true),
      open: () => Effect.die(new Error("unexpected browser")),
      observe: () => Effect.die(new Error("unexpected browser")),
      interact: () => Effect.die(new Error("unexpected browser")),
      close: () => Effect.die(new Error("unexpected browser")),
    };
    const execute = BrowserTask.make(db, runtime, []).execute;
    expect(yield* execute(request)).toEqual({ _tag: "Unavailable" });
  }),
);
