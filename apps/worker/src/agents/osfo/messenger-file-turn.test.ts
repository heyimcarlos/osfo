/* oxlint-disable effecttsgo/prefer-schema-over-json -- These assertions inspect serialized provider projections, not untrusted JSON decoding. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect tests. */
import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { ThinkSubmissionId } from "../../domain";
import {
  harness,
  history,
  messenger,
  metadata,
  source,
} from "../../../test/support/messenger-file-turn";
import { MessengerFileTurn } from "./messenger-file-turn";

it.effect(
  "persists owned references before returning the current model message and preserves surrounding history",
  () =>
    Effect.gen(function* () {
      const test = harness();
      const messages = yield* MessengerFileTurn.prepare(
        { metadata, messages: [source], modelMessages: history },
        test.dependencies,
      );
      expect(test.events).toEqual(["authorize", "download", "upload", "authorize", "persist"]);
      expect(messages[0]).toBe(history[0]);
      expect(messages[1]).toBe(history[1]);
      expect(messages[3]).toBe(history[3]);
      expect(JSON.stringify(messages[2])).toContain("owned File messenger-file-");
      expect(JSON.stringify(messages[2])).toContain("retain unknown fields");
      expect(JSON.stringify(messages)).not.toContain("https://media.invalid");
      expect(test.persisted[0]?.id).toBe(source.id);
      expect(test.persisted[0]?.metadata).toBe(source.metadata);
    }),
);

it.effect(
  "replays from retained provider text without downloading or duplicating result annotations",
  () =>
    Effect.gen(function* () {
      const test = harness();
      const first = yield* MessengerFileTurn.prepare(
        { metadata, messages: [source], modelMessages: history },
        test.dependencies,
      );
      const prepared = test.persisted[0];
      if (prepared === undefined) throw new Error("Expected retained message");
      const replay = yield* MessengerFileTurn.prepare(
        { metadata, messages: [prepared], modelMessages: first },
        test.dependencies,
      );
      expect(replay).toEqual(first);
      expect(test.events.filter((event) => event === "download")).toHaveLength(1);
      expect(test.events.filter((event) => event === "upload")).toHaveLength(1);
      expect(test.files.size).toBe(1);
    }),
);

it.effect("does not process an earlier submission on an unrelated turn", () =>
  Effect.gen(function* () {
    const test = harness();
    const messages = yield* MessengerFileTurn.prepare(
      {
        metadata: { ...metadata, submissionId: ThinkSubmissionId.make("other-turn") },
        messages: [source],
        modelMessages: history,
      },
      test.dependencies,
    );
    expect(messages).toBe(history);
    expect(test.events).toEqual([]);
  }),
);

it.effect("rejects retained sender or endpoint mismatches before accessing provider bytes", () =>
  Effect.forEach(
    [
      { ...messenger, messengerId: "different-endpoint" },
      { ...messenger, message: { ...messenger.message, author: { userId: "different-owner" } } },
    ],
    (context) =>
      Effect.gen(function* () {
        const test = harness();
        const result = yield* MessengerFileTurn.prepare(
          {
            metadata,
            messages: [{ ...source, metadata: { messenger: context } }],
            modelMessages: history,
          },
          test.dependencies,
        ).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(test.events).toEqual([]);
      }),
  ),
);

it.effect("rejects malformed retained metadata without forwarding raw file URLs", () =>
  Effect.gen(function* () {
    const test = harness();
    const result = yield* MessengerFileTurn.prepare(
      {
        metadata,
        messages: [{ ...source, metadata: { messenger: null } }],
        modelMessages: history,
      },
      test.dependencies,
    ).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(test.events).toEqual([]);
  }),
);

it.effect("stops revoked authority before download and before retaining any model references", () =>
  Effect.gen(function* () {
    const test = harness();
    const result = yield* MessengerFileTurn.prepare(
      { metadata, messages: [source], modelMessages: history },
      { ...test.dependencies, authorize: Effect.succeed(false) },
    ).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(test.events).toEqual([]);
  }),
);

it.effect("stops authority revoked during processing before message persistence", () =>
  Effect.gen(function* () {
    const test = harness();
    let checks = 0;
    const result = yield* MessengerFileTurn.prepare(
      { metadata, messages: [source], modelMessages: history },
      { ...test.dependencies, authorize: Effect.sync(() => ++checks === 1) },
    ).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(test.events).toEqual(["download", "upload"]);
  }),
);

it.effect("gives captionless attachments a concrete inspection request", () =>
  Effect.gen(function* () {
    const test = harness();
    const messages = yield* MessengerFileTurn.prepare(
      {
        metadata,
        messages: [
          {
            ...source,
            metadata: { messenger: { ...messenger, message: { ...messenger.message, text: "" } } },
          },
        ],
        modelMessages: history,
      },
      test.dependencies,
    );
    expect(JSON.stringify(messages)).toContain("Please inspect the attached files.");
  }),
);
