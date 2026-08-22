import type { StreamCallback } from "@cloudflare/think";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import { emitTextDelta, makeMessengerStream } from "./messenger-stream";

/* oxlint-disable vitest/no-standalone-expect -- Oxlint does not recognize assertions inside @effect/vitest's it.effect callback here. */

describe("Messenger stream", () => {
  it.effect("does not retain sensitive delivery input in callback failures", () =>
    Effect.gen(function* () {
      const invite = "https://osfo.test/verify/aB12cD34";
      const callback = {
        onDone: () => undefined,
        onError: () => undefined,
        onEvent: (event: string) => {
          throw new Error(`delivery rejected ${event}`);
        },
        onStart: () => undefined,
      } satisfies StreamCallback;

      const failure = yield* emitTextDelta(makeMessengerStream(callback), invite).pipe(Effect.flip);

      expect(failure).toHaveProperty("cause");
      expect(Predicate.isError(failure.cause)).toBe(true);
      if (!Predicate.isError(failure.cause)) return;
      expect(failure.cause.message).toContain("delivery rejected");
      expect(failure.cause.message).not.toContain(invite);
      expect(failure.cause.message).not.toContain("aB12cD34");
      expect(failure.message).not.toContain(invite);
      expect(failure.message).not.toContain("aB12cD34");
    }),
  );
});
