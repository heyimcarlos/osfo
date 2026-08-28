/* oxlint-disable vitest/no-standalone-expect, unicorn/consistent-function-scoping -- Assertions execute inside Effects; local binding factories keep each race fixture visible beside its expectations. */
import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { AllowancePeriodId, UserId } from "../domain";
import { ContentId } from "../domain/client-content";
import { DocumentArtifact } from "../domain/document-artifact";
import { DocumentBuild } from "../services/document-build";
import { DocumentBuildFollowUp } from "../services/document-build-follow-up";
import { DocumentIntentDigest } from "../services/document-generation";
import { DocumentBuildComposition } from "./document-build";

const mainId = DocumentBuild.CloudflareInstanceId.make("document-build-main");
const timerId = DocumentBuild.CloudflareInstanceId.make("document-build-timer");
const payload = DocumentBuild.WorkflowPayload.make({
  inputDigest: DocumentBuild.InputDigest.make("a".repeat(64)),
  workflowId: DocumentBuild.WorkflowId.make("document-build:stable"),
});

it.effect("reconciles ambiguous acceptance for both stable Workflow instances", () => {
  const calls = new Array<string>();
  const binding = (kind: string): DocumentBuildComposition.WorkflowBinding => ({
    create: ({ id }) => {
      calls.push(`${kind}:create:${id}`);
      return Promise.reject(new Error("acknowledgement lost"));
    },
    get: (id) => {
      calls.push(`${kind}:get:${id}`);
      return Promise.resolve({
        status: () => Promise.resolve({ status: "queued" as const }),
        terminate: () => Promise.resolve(),
      });
    },
  });

  return Effect.gen(function* () {
    yield* DocumentBuildComposition.makeWorkflowPort(binding("main"), binding("timer")).create(
      mainId,
      timerId,
      payload,
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        `main:create:${mainId}`,
        `main:get:${mainId}`,
        `timer:create:${timerId}`,
        `timer:get:${timerId}`,
      ]),
    );
  });
});

it.effect("retains create uncertainty when either stable identity is unknown", () => {
  const binding = (status: "queued" | "unknown"): DocumentBuildComposition.WorkflowBinding => ({
    create: () => Promise.reject(new Error("acknowledgement lost")),
    get: () =>
      Promise.resolve({
        status: () => Promise.resolve({ status }),
        terminate: () => Promise.resolve(),
      }),
  });

  return Effect.gen(function* () {
    const result = yield* DocumentBuildComposition.makeWorkflowPort(
      binding("queued"),
      binding("unknown"),
    )
      .create(mainId, timerId, payload)
      .pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "DocumentBuildUnavailable",
        operation: "workflow.create",
      });
    }
  });
});

it.effect("terminates only executable main and timer instances", () => {
  const terminated = new Array<string>();
  const binding = (status: "running" | "complete"): DocumentBuildComposition.WorkflowBinding => ({
    create: () => Promise.reject(new Error("unexpected create")),
    get: (id) =>
      Promise.resolve({
        status: () => Promise.resolve({ status }),
        terminate: () => {
          terminated.push(id);
          return Promise.resolve();
        },
      }),
  });

  return Effect.gen(function* () {
    yield* DocumentBuildComposition.makeWorkflowPort(
      binding("running"),
      binding("complete"),
    ).terminate(mainId, timerId);
    expect(terminated).toEqual([mainId]);
  });
});

it.effect("keeps Directory follow-up outages in the typed retryable channel", () =>
  Effect.gen(function* () {
    const result = yield* DocumentBuildComposition.submitFollowUp(
      {
        OSFO_DIRECTORY: {
          getByName: () => ({
            resolveDocumentBuildFiles: () => Promise.reject(new Error("unexpected resolver")),
            submitDocumentBuildFollowUp: () => Promise.reject(new Error("Directory unavailable")),
          }),
        },
      },
      DocumentBuildFollowUp.NotificationId.make("document-build-follow-up-id"),
    ).pipe(Effect.result);

    expect(result).toMatchObject({
      failure: { _tag: "DocumentBuildUnavailable", operation: "followUp.directory" },
    });
  }),
);

it.effect("cleans attempt evidence and Sandbox after a crash before the preview marker", () => {
  const events = new Array<string>();
  return Effect.gen(function* () {
    yield* DocumentBuildComposition.discardPendingArtifact(
      {
        userId: UserId.make("document-build-user"),
        workflowId: DocumentBuild.WorkflowId.make("document-build:crash-cleanup"),
      },
      {
        deleteArtifact: () => Effect.sync(() => void events.push("artifact")),
        discardAttempt: () => Effect.sync(() => void events.push("attempt")),
        dispose: () => Effect.sync(() => void events.push("sandbox")),
        inspectArtifact: () => Effect.succeed(null),
      },
    );
    expect(events).toEqual(["attempt", "sandbox"]);
  });
});

it.effect("does not delete or dispose compute for a foreign pending artifact", () => {
  const events = new Array<string>();
  const workflowId = DocumentBuild.WorkflowId.make("document-build:foreign-cleanup");
  const contentId = ContentId.make(`document:workflow:${workflowId}`);
  return Effect.gen(function* () {
    const artifact = yield* DocumentArtifact.make(contentId, "pdf", 3, 1, "f".repeat(64));
    const result = yield* DocumentBuildComposition.discardPendingArtifact(
      { userId: UserId.make("document-build-user"), workflowId },
      {
        deleteArtifact: () => Effect.sync(() => void events.push("artifact")),
        discardAttempt: () => Effect.sync(() => void events.push("attempt")),
        dispose: () => Effect.sync(() => void events.push("sandbox")),
        inspectArtifact: () =>
          Effect.succeed({
            allowancePeriodId: AllowancePeriodId.make("document-build-period"),
            artifact,
            cost: { _tag: "ProvenNoUse" },
            format: "pdf",
            intentDigest: DocumentIntentDigest.make("a".repeat(64)),
            owner: DocumentArtifact.DocumentOwner.make({
              _tag: "Workflow",
              workflowId: DocumentBuild.WorkflowId.make("document-build:other"),
            }),
            retention: "pending",
            userId: UserId.make("other-user"),
          }),
      },
    ).pipe(Effect.result);

    expect(result).toMatchObject({ failure: { operation: "artifact.discard.identity" } });
    expect(events).toEqual([]);
  });
});
