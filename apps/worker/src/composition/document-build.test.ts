/* oxlint-disable vitest/no-standalone-expect, unicorn/consistent-function-scoping -- Assertions execute inside Effects; local binding factories keep each race fixture visible beside its expectations. */
import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { AgentId, AllowancePeriodId, UserId } from "../domain";
import { ContentId } from "../domain/client-content";
import { FileDigest } from "../domain/file-content";
import { FileId } from "../domain/file";
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

for (const tag of ["Accepted", "Replayed", "TerminalSuperseded"] as const) {
  it.effect(`decodes the ${tag} follow-up acknowledgement`, () =>
    Effect.gen(function* () {
      const notificationId = DocumentBuildFollowUp.NotificationId.make(
        `document-build-${tag}-notification`,
      );
      const result = yield* DocumentBuildComposition.submitFollowUp(
        directoryBinding({
          followUp: {
            _tag: tag,
            notificationId,
            submissionId: `document-build-${tag}-submission`,
          },
        }),
        notificationId,
      );

      expect(result).toMatchObject({ _tag: tag, notificationId });
    }),
  );
}

it.effect("rejects malformed and stale follow-up acknowledgements as retryable", () =>
  Effect.gen(function* () {
    const notificationId = DocumentBuildFollowUp.NotificationId.make("document-build-notification");
    const malformed = yield* DocumentBuildComposition.submitFollowUp(
      directoryBinding({ followUp: { _tag: "Accepted", notificationId } }),
      notificationId,
    ).pipe(Effect.result);
    const stale = yield* DocumentBuildComposition.submitFollowUp(
      directoryBinding({
        followUp: {
          _tag: "Accepted",
          notificationId: "other-notification",
          submissionId: "document-build-submission",
        },
      }),
      notificationId,
    ).pipe(Effect.result);

    expect(malformed).toMatchObject({ failure: { operation: "followUp.decode" } });
    expect(stale).toMatchObject({ failure: { operation: "followUp.identity" } });
  }),
);

it.effect("adapts a valid Agent follow-up failure result to Document Build unavailability", () =>
  Effect.gen(function* () {
    const notificationId = DocumentBuildFollowUp.NotificationId.make("document-build-notification");
    const result = yield* DocumentBuildComposition.submitFollowUp(
      directoryBinding({ followUp: { _tag: "DocumentBuildFollowUpUnavailable" } }),
      notificationId,
    ).pipe(Effect.result);

    expect(result).toMatchObject({
      failure: { _tag: "DocumentBuildUnavailable", operation: "followUp.decode" },
    });
  }),
);

for (const files of [
  { _tag: "Resolved", files: [{ fileId: "missing-authoritative-fields" }] },
  { _tag: "UnknownResult" },
]) {
  it.effect("rejects malformed Directory file resolution results as retryable", () =>
    Effect.gen(function* () {
      const result = yield* DocumentBuildComposition.makeFileResolver(
        directoryBinding({ files }).OSFO_DIRECTORY,
      )
        .resolve(AgentId.make("document-build-agent"), UserId.make("document-build-user"), [
          FileId.make("document-build-file"),
        ])
        .pipe(Effect.result);

      expect(result).toMatchObject({
        failure: { _tag: "DocumentBuildUnavailable", operation: "files.resolve.decode" },
      });
    }),
  );
}

for (const returnedIds of [
  ["source-a"],
  ["source-b", "source-a"],
  ["source-a", "unrelated-source"],
]) {
  it.effect("rejects a validly shaped file response with mismatched ordered identities", () =>
    Effect.gen(function* () {
      const result = yield* DocumentBuildComposition.makeFileResolver(
        directoryBinding({
          files: { _tag: "Resolved", files: returnedIds.map(resolvedRpcFile) },
        }).OSFO_DIRECTORY,
      )
        .resolve(AgentId.make("document-build-agent"), UserId.make("document-build-user"), [
          FileId.make("source-a"),
          FileId.make("source-b"),
        ])
        .pipe(Effect.result);

      expect(result).toMatchObject({
        failure: { _tag: "DocumentBuildUnavailable", operation: "files.resolve.identity" },
      });
    }),
  );
}

it.effect("classifies only a proven unavailable file as a permanent source change", () =>
  Effect.gen(function* () {
    const result = yield* DocumentBuildComposition.makeFileResolver(
      directoryBinding({ files: { _tag: "Unavailable", reason: "fileUnavailable" } })
        .OSFO_DIRECTORY,
    )
      .resolve(AgentId.make("document-build-agent"), UserId.make("document-build-user"), [
        FileId.make("document-build-file"),
      ])
      .pipe(Effect.result);

    expect(result).toMatchObject({ failure: { _tag: "DocumentBuildSourceChanged" } });
  }),
);

it.effect("keeps an explicit resolver outage retryable at the composition boundary", () =>
  Effect.gen(function* () {
    const result = yield* DocumentBuildComposition.makeFileResolver(
      directoryBinding({ files: { _tag: "Unavailable", reason: "resolverUnavailable" } })
        .OSFO_DIRECTORY,
    )
      .resolve(AgentId.make("document-build-agent"), UserId.make("document-build-user"), [
        FileId.make("document-build-file"),
      ])
      .pipe(Effect.result);

    expect(result).toMatchObject({
      failure: {
        _tag: "DocumentBuildUnavailable",
        operation: "files.resolve.resolverUnavailable",
      },
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

const directoryBinding = (results: {
  readonly files?: unknown;
  readonly followUp?: unknown;
}): Pick<DocumentBuildComposition.Bindings, "OSFO_DIRECTORY"> => ({
  OSFO_DIRECTORY: {
    getByName: () => ({
      resolveDocumentBuildFiles: () => Promise.resolve(results.files),
      submitDocumentBuildFollowUp: () => Promise.resolve(results.followUp),
    }),
  },
});

const resolvedRpcFile = (identity: string) => ({
  byteLength: "6",
  fileId: FileId.make(identity),
  fileName: `${identity}.txt`,
  mediaType: "text/plain",
  normalizedText: "source",
  sha256: FileDigest.make(`sha256:${"a".repeat(64)}`),
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
