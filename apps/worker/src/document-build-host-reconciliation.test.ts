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
    yield* repair([recoveryCandidate], {
      create: (main, timer, payload) =>
        Effect.sync(() => void calls.push({ main, payload, timer })),
      terminate: () => Effect.void,
    });
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

it.effect("continues the scheduled batch after one host remains unavailable", () => {
  const attempted = new Array<string>();
  return Effect.gen(function* () {
    yield* repair([candidate("a"), candidate("b")], {
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
    });
    expect(attempted).toHaveLength(2);
    expect(attempted).toEqual(expect.arrayContaining(["document-build:a", "document-build:b"]));
  });
});
