/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";

import { ThinkRequestId } from "../../domain";
import {
  CommittedTurnTerminal,
  persistThinkTerminalBeforeCapture,
  readCommittedTurnTerminal,
  ThinkTerminalPersistenceUnavailable,
  withCommittedTurnTerminal,
} from "./committed-turn-terminal";

describe("committed turn terminal metadata", () => {
  it("preserves existing message metadata and reads its trusted marker", () => {
    const terminal = CommittedTurnTerminal.make({
      requestId: ThinkRequestId.make("request-1"),
      status: "completed",
    });
    const metadata = withCommittedTurnTerminal({ provider: { model: "test" } }, terminal);

    expect(metadata).toEqual({
      osfoCommittedTurn: terminal,
      provider: { model: "test" },
    });
    expect(readCommittedTurnTerminal(metadata)).toEqual(Option.some(terminal));
  });

  it("rejects malformed terminal metadata", () => {
    expect(
      readCommittedTurnTerminal({
        osfoCommittedTurn: { requestId: "request-1", status: "streaming" },
      }),
    ).toEqual(Option.none());
  });

  it.effect("keeps the committed Think terminal when provider capture fails", () =>
    Effect.gen(function* () {
      let persistedTerminal = false;
      const outcome = yield* persistThinkTerminalBeforeCapture(
        () => {
          persistedTerminal = true;
          return Promise.resolve();
        },
        Effect.gen(function* () {
          expect(persistedTerminal).toBe(true);
          return yield* Effect.fail({ _tag: "CaptureUnavailable" as const });
        }),
      ).pipe(Effect.result);

      expect(Result.isFailure(outcome)).toBe(true);
      expect(persistedTerminal).toBe(true);
    }),
  );

  it.effect("returns a typed failure when Think terminal persistence fails", () =>
    Effect.gen(function* () {
      let captureStarted = false;
      const outcome = yield* persistThinkTerminalBeforeCapture(
        () => Promise.reject(new Error("storage offline")),
        Effect.sync(() => {
          captureStarted = true;
        }),
      ).pipe(Effect.result);

      expect(outcome).toEqual(
        Result.fail(
          expect.objectContaining({
            _tag: "ThinkTerminalPersistenceUnavailable",
            message: "Think terminal persistence is unavailable",
          }),
        ),
      );
      expect(captureStarted).toBe(false);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure).toBeInstanceOf(ThinkTerminalPersistenceUnavailable);
      }
    }),
  );
});
