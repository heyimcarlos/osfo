import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { getAgentByName } from "agents";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/run-effect-inside-effect -- Durable Object tests cross RPC, alarm, and Effect boundaries. */

describe("Registration Dialogue", () => {
  it.effect("keeps a natural conversation available for every invitation turn", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = Object.getOwnPropertyDescriptor(env.AI, "run");
        let calls = 0;
        Object.defineProperty(env.AI, "run", {
          configurable: true,
          value: () => {
            calls += 1;
            return Promise.resolve({
              response: calls === 1 ? "A tiny plan sounds fun." : "Still here.",
            });
          },
        });
        return { calls: () => calls, previous };
      }),
      (probe) =>
        Effect.gen(function* () {
          const dialogue = yield* Effect.promise(() =>
            getAgentByName(env.REGISTRATION_DIALOGUE, "registration-multi-turn"),
          );
          const replies = yield* Effect.promise(() =>
            runInDurableObject(dialogue, async (instance) => {
              const first = recordingCallback();
              const second = recordingCallback();
              const firstResult = await instance.reply(
                {
                  eventId: "telegram-first",
                  locale: "en",
                  message: "Help me plan my week.",
                  verifyUrl: "https://osfo.ai/verify/token-first",
                },
                first.callback,
              );
              const secondResult = await instance.reply(
                {
                  eventId: "telegram-second",
                  locale: "en",
                  message: "Are you still there?",
                  verifyUrl: "https://osfo.ai/verify/ignored-token",
                },
                second.callback,
              );
              return {
                first: first.text(),
                firstResult,
                second: second.text(),
                secondResult,
              };
            }),
          );

          expect(replies.first).toBe(
            "Register to keep using Osfo: https://osfo.ai/verify/token-first\n\nA tiny plan sounds fun.",
          );
          expect(replies.second).toBe(
            "Register to keep using Osfo: https://osfo.ai/verify/token-first\n\nStill here.",
          );
          expect(replies.firstResult).toEqual({ _tag: "RegistrationDialogueCompleted" });
          expect(replies.secondResult).toEqual({ _tag: "RegistrationDialogueCompleted" });
          expect(probe.calls()).toBe(2);
        }),
      ({ previous }) =>
        Effect.sync(() => {
          if (previous === undefined) Reflect.deleteProperty(env.AI, "run");
          else Object.defineProperty(env.AI, "run", previous);
        }),
    ),
  );

  it.effect("keeps the registration link visible when inference fails", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = Object.getOwnPropertyDescriptor(env.AI, "run");
        Object.defineProperty(env.AI, "run", {
          configurable: true,
          value: () => Promise.reject(new Error("model unavailable")),
        });
        return previous;
      }),
      () =>
        Effect.gen(function* () {
          const dialogue = yield* Effect.promise(() =>
            getAgentByName(env.REGISTRATION_DIALOGUE, "registration-fallback"),
          );
          const reply = yield* Effect.promise(() =>
            runInDurableObject(dialogue, async (instance) => {
              const recorded = recordingCallback();
              const result = await instance.reply(
                {
                  eventId: "telegram-fallback",
                  locale: "en",
                  message: "Hello",
                  verifyUrl: "https://osfo.ai/verify/token-fallback",
                },
                recorded.callback,
              );
              return { result, text: recorded.text() };
            }),
          );

          expect(reply).toEqual({
            result: { _tag: "RegistrationDialogueCompleted" },
            text: "Register to keep using Osfo: https://osfo.ai/verify/token-fallback",
          });
        }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) Reflect.deleteProperty(env.AI, "run");
          else Object.defineProperty(env.AI, "run", previous);
        }),
    ),
  );

  it.effect("deletes all temporary transcript data after registration and expiry", () =>
    Effect.gen(function* () {
      const completed = yield* Effect.promise(() =>
        getAgentByName(env.REGISTRATION_DIALOGUE, "registration-delete-completed"),
      );
      yield* Effect.promise(() =>
        runInDurableObject(completed, async (_instance, state) => {
          await state.storage.put("temporary-transcript", { message: "temporary request" });
          await state.storage.setAlarm(Date.now() + 60_000);
        }),
      );
      yield* Effect.promise(async () => await completed.deleteDialogue());
      const completedState = yield* Effect.promise(() =>
        runInDurableObject(completed, async (_instance, state) => ({
          alarm: await state.storage.getAlarm(),
          transcript: await state.storage.get("temporary-transcript"),
        })),
      );

      const expired = yield* Effect.promise(() =>
        getAgentByName(env.REGISTRATION_DIALOGUE, "registration-delete-expired"),
      );
      const expiredState = yield* Effect.promise(() =>
        runInDurableObject(expired, async (instance, state) => {
          await state.storage.put("temporary-transcript", { message: "temporary request" });
          await instance.expireDialogue();
          return await state.storage.get("temporary-transcript");
        }),
      );

      expect(completedState).toEqual({ alarm: null, transcript: undefined });
      expect(expiredState).toBeUndefined();
    }),
  );
});

const recordingCallback = () => {
  const deltas: Array<string> = [];
  return {
    callback: {
      onDone: () => undefined,
      onError: () => undefined,
      onEvent: (json: string) => {
        const chunk = Schema.decodeSync(
          Schema.fromJsonString(Schema.Struct({ delta: Schema.optionalKey(Schema.String) })),
        )(json);
        if (chunk.delta !== undefined) deltas.push(chunk.delta);
      },
      onStart: () => undefined,
    },
    text: () => deltas.join(""),
  };
};
