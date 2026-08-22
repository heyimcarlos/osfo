import type { StreamCallback } from "@cloudflare/think";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { emitTextDelta } from "./messenger-stream";

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

      const failure = yield* emitTextDelta(callback, invite).pipe(Effect.flip);

      expect(failure).not.toHaveProperty("cause");
      expect(failure.message).not.toContain(invite);
      expect(failure.message).not.toContain("aB12cD34");
    }),
  );
});
