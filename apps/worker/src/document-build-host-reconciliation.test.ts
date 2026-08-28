/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect tests. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { DocumentBuild } from "./services/document-build";
import { repair } from "./document-build-host-reconciliation";

const candidate = (identity: string) => ({
  inputDigest: DocumentBuild.InputDigest.make(identity.repeat(64)),
  mainInstanceId: DocumentBuild.CloudflareInstanceId.make(`document-build-${identity}-main`),
  timerInstanceId: DocumentBuild.CloudflareInstanceId.make(`document-build-${identity}-timer`),
  workflowId: DocumentBuild.WorkflowId.make(`document-build:${identity}`),
});

it.effect("repairs a bounded batch by exact stable timer and main identities", () => {
  const calls = new Array<unknown>();
  const recoveryCandidate = {
    inputDigest: DocumentBuild.InputDigest.make("a".repeat(64)),
    mainInstanceId: DocumentBuild.CloudflareInstanceId.make("document-build-recovery-main"),
    timerInstanceId: DocumentBuild.CloudflareInstanceId.make("document-build-recovery-timer"),
    workflowId: DocumentBuild.WorkflowId.make("document-build:recovery"),
  };
  return Effect.gen(function* () {
    yield* repair(
      [recoveryCandidate],
      {
        create: (main, timer, payload) =>
          Effect.sync(() => void calls.push({ main, payload, timer })),
        terminate: () => Effect.void,
      },
      () => Effect.succeed("Keep"),
    );
    expect(calls).toEqual([
      {
        main: recoveryCandidate.mainInstanceId,
        payload: {
          inputDigest: recoveryCandidate.inputDigest,
          workflowId: recoveryCandidate.workflowId,
        },
        timer: recoveryCandidate.timerInstanceId,
      },
    ]);
  });
});

it.effect(
  "attempts every candidate and fails the scheduled batch when one host remains unavailable",
  () => {
    const attempted = new Array<string>();
    return Effect.gen(function* () {
      const result = yield* repair(
        [candidate("a"), candidate("b")],
        {
          create: (_main, _timer, payload) =>
            Effect.gen(function* () {
              attempted.push(payload.workflowId);
              if (payload.workflowId === "document-build:a") {
                return yield* new DocumentBuild.Unavailable({
                  cause: "host unavailable",
                  message: "Workflow host is unavailable",
                  operation: "test.repair",
                });
              }
              return undefined;
            }),
          terminate: () => Effect.void,
        },
        () => Effect.succeed("Keep"),
      ).pipe(Effect.result);
      expect(attempted).toHaveLength(2);
      expect(attempted).toEqual(expect.arrayContaining(["document-build:a", "document-build:b"]));
      expect(result).toMatchObject({
        failure: { message: "Document Build host repair failed for 1 candidate(s)" },
      });
    });
  },
);

it.effect(
  "terminates both repaired hosts when the serialized postcheck finds deletion fencing",
  () => {
    const terminated = new Array<unknown>();
    return Effect.gen(function* () {
      yield* repair(
        [candidate("f")],
        {
          create: () => Effect.void,
          terminate: (main, timer) => Effect.sync(() => void terminated.push({ main, timer })),
        },
        () => Effect.succeed("Terminate"),
      );
      expect(terminated).toEqual([
        {
          main: "document-build-f-main",
          timer: "document-build-f-timer",
        },
      ]);
    });
  },
);

it.effect("reports the complete candidate failure count without stopping early", () => {
  const attempted = new Array<string>();
  return Effect.gen(function* () {
    const result = yield* repair(
      [candidate("c"), candidate("d")],
      {
        create: (_main, _timer, payload) =>
          Effect.sync(() => {
            attempted.push(payload.workflowId);
          }),
        terminate: () => Effect.void,
      },
      () =>
        Effect.fail(
          new DocumentBuild.Unavailable({
            cause: "test",
            message: "Postcheck unavailable",
            operation: "test.postcheck",
          }),
        ),
    ).pipe(Effect.result);

    expect(attempted).toHaveLength(2);
    expect(result).toMatchObject({
      failure: { message: "Document Build host repair failed for 2 candidate(s)" },
    });
  });
});
