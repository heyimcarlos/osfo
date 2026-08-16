import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/run-effect-inside-effect -- Durable Object tests cross RPC, alarm, and Effect boundaries. */

describe("Registration Dialogue", () => {
  it.effect("runs one natural Registration Turn and uses deterministic prompts after it", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = Object.getOwnPropertyDescriptor(env.AI, "run");
        let calls = 0;
        Object.defineProperty(env.AI, "run", {
          configurable: true,
          value: () => {
            calls += 1;
            return Promise.resolve({ response: "I can help you plan your week." });
          },
        });
        return { calls: () => calls, previous };
      }),
      (probe) =>
        Effect.gen(function* () {
          const dialogue = env.REGISTRATION_DIALOGUE.getByName("registration-natural-turn");
          const first = yield* Effect.promise(
            async () =>
              await dialogue.begin({
                eventId: "wamid-first",
                locale: "en",
                message: "Help me plan my week.",
                verifyUrl: "https://osfo.ai/verify/token-first",
              }),
          );
          const exactRetry = yield* Effect.promise(
            async () =>
              await dialogue.begin({
                eventId: "wamid-first",
                locale: "en",
                message: "Help me plan my week.",
                verifyUrl: "https://osfo.ai/verify/token-first",
              }),
          );
          const laterMessage = yield* Effect.promise(
            async () =>
              await dialogue.begin({
                eventId: "wamid-later",
                locale: "en",
                message: "Are you there?",
                verifyUrl: "https://osfo.ai/verify/ignored-token",
              }),
          );

          expect(first).toEqual({
            _tag: "RegistrationTurnCompleted",
            response:
              "I can help you plan your week. Use your registration link to continue: https://osfo.ai/verify/token-first",
          });
          expect(exactRetry).toEqual(first);
          expect(laterMessage).toEqual({
            _tag: "RegistrationTurnCompleted",
            response: "Use your registration link to continue: https://osfo.ai/verify/token-first",
          });
          expect(probe.calls()).toBe(1);
        }),
      ({ previous }) =>
        Effect.sync(() => {
          if (previous === undefined) Reflect.deleteProperty(env.AI, "run");
          else Object.defineProperty(env.AI, "run", previous);
        }),
    ),
  );

  it.effect("deletes all temporary transcript data after registration and expiry", () =>
    Effect.gen(function* () {
      const completed = env.REGISTRATION_DIALOGUE.getByName("registration-delete-completed");
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

      const expired = env.REGISTRATION_DIALOGUE.getByName("registration-delete-expired");
      const expiredState = yield* Effect.promise(() =>
        runInDurableObject(expired, async (instance, state) => {
          await state.storage.put("temporary-transcript", { message: "temporary request" });
          await instance.alarm();
          return await state.storage.get("temporary-transcript");
        }),
      );

      expect(completedState).toEqual({ alarm: null, transcript: undefined });
      expect(expiredState).toBeUndefined();
    }),
  );
});
