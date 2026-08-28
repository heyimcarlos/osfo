/* oxlint-disable vitest/no-standalone-expect, effecttsgo/global-date, effecttsgo/strict-effect-provide -- Assertions execute inside Effect tests with fixed timestamps and a test-owned complete Layer. */
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  AgentId,
  AllowancePeriodId,
  CapabilityCatalogVersion,
  ConversationRouteId,
  ModelAccessPolicyVersion,
  PlanPolicyVersion,
  ResourcePriceVersion,
  SessionId,
  UserId,
} from "../domain";
import { ActionId } from "../domain/action-execution";
import { AuthSessionId } from "../domain/auth-session";
import { FileDigest } from "../domain/file-content";
import { FileId } from "../domain/file";
import { ManagedModelRoute } from "../domain/model-access-policy";
import { currentLaunchPolicy, policyFor } from "../domain/plan-policy";
import { emptyLiveResourceFacts, type AuthorizationContext } from "./authorization";
import { DocumentBuild } from "./document-build";

it.effect("preserves every character of a source token longer than one line", () =>
  Effect.gen(function* () {
    const token = "abcdefghij".repeat(21);
    const request = yield* DocumentBuild.storedRequestFor("pdf", [resolvedFile(token)]);

    expect(request.source.pages.flatMap(({ lines }) => lines).join("")).toBe(token);
    expect(
      request.source.pages.flatMap(({ lines }) => lines).every((line) => line.length <= 80),
    ).toBe(true);
  }),
);

it.effect("rejects source content that requires more than twenty pages", () =>
  Effect.gen(function* () {
    const oversized = Array.from({ length: 601 }, () => "x".repeat(80)).join(" ");
    const result = yield* DocumentBuild.storedRequestFor("docx", [resolvedFile(oversized)]).pipe(
      Effect.result,
    );

    expect(result).toMatchObject({
      failure: { _tag: "DocumentBuildSourceRejected", reason: "pageLimit" },
    });
  }),
);

it.effect("admits Free Document Build despite the superseded zero Workflow counter", () =>
  Effect.gen(function* () {
    let retained: DocumentBuild.Record | null = null;
    let hostsCreated = 0;
    let retainedActiveWorkflowLimit: bigint | null = null;
    const port = DocumentBuild.Port.of({
      commitPreviewReadyFollowUp: () => Effect.void,
      commitTerminalFollowUp: () => Effect.void,
      currentAuthorization: () => Effect.succeed(exhaustedAuthorization("free", false)),
      discardPendingArtifact: () => Effect.void,
      files: { resolve: () => Effect.succeed([resolvedFile("source text")]) },
      persistence: {
        admit: (build, activeWorkflowLimit) =>
          Effect.sync(() => {
            retained = build;
            retainedActiveWorkflowLimit = activeWorkflowLimit;
            return { _tag: "Created" as const, build };
          }),
        beginExecution: () => Effect.die(new Error("Unexpected execution")),
        commitPublication: () => Effect.die(new Error("Unexpected publication")),
        enforceDeadline: () => Effect.die(new Error("Unexpected deadline")),
        finishSuccess: () => Effect.die(new Error("Unexpected success")),
        finishTerminal: () => Effect.die(new Error("Unexpected terminal transition")),
        inspect: () => Effect.succeed(retained),
        markAccepted: (_workflowId, _inputDigest, acceptedAt) =>
          Effect.gen(function* () {
            if (retained === null) return yield* Effect.die(new Error("Missing admitted build"));
            retained = { ...retained, acceptedAt, state: "accepted" };
            return retained;
          }),
        markAccountingCommitted: () => Effect.die(new Error("Unexpected accounting")),
        markPreviewStored: () => Effect.die(new Error("Unexpected preview")),
        recordProviderCost: () => Effect.die(new Error("Unexpected provider cost")),
        requestCancel: () => Effect.die(new Error("Unexpected cancel")),
      },
      recordWorkflowStart: () => Effect.void,
      workflow: {
        create: () => Effect.sync(() => void (hostsCreated += 1)),
        terminate: () => Effect.void,
      },
    });
    const layer = DocumentBuild.layerWithoutDependencies.pipe(
      Layer.provide(Layer.succeed(DocumentBuild.Port, port)),
    );
    const result = yield* DocumentBuild.Service.pipe(
      Effect.flatMap((builds) =>
        builds.start({
          actionId: ActionId.make("free-document-build-action"),
          agentId: AgentId.make("free-document-build-agent"),
          authorization: exhaustedAuthorization("free", false),
          request: { fileIds: [FileId.make("document-build-source")], format: "pdf" },
          routeId: ConversationRouteId.make("free-document-build-route"),
          sessionId: SessionId.make("free-document-build-session"),
        }),
      ),
      Effect.provide(layer),
    );

    expect(result).toMatchObject({ _tag: "Started", build: { state: "accepted" } });
    expect(hostsCreated).toBe(1);
    expect(retainedActiveWorkflowLimit).toBe(1n);
  }),
);

it.effect("continues admitted work after allowance exhaustion while denying a new Workflow", () =>
  Effect.gen(function* () {
    const request = yield* DocumentBuild.storedRequestFor("pdf", [resolvedFile("source text")]);
    const workflowId = DocumentBuild.WorkflowId.make("document-build:continuity");
    const instances = yield* DocumentBuild.cloudflareInstanceIdsFor(workflowId);
    const build = buildRecord(workflowId, instances, request);
    let admissions = 0;
    let providerStarts = 0;
    const port = DocumentBuild.Port.of({
      commitPreviewReadyFollowUp: () => Effect.void,
      commitTerminalFollowUp: () => Effect.void,
      currentAuthorization: () => Effect.succeed(exhaustedAuthorization("free")),
      discardPendingArtifact: () => Effect.void,
      files: { resolve: () => Effect.succeed([resolvedFile("source text")]) },
      persistence: {
        admit: () =>
          Effect.sync(() => {
            admissions += 1;
            return { _tag: "Created" as const, build };
          }),
        beginExecution: () => Effect.succeed(build),
        commitPublication: () => Effect.succeed(build),
        enforceDeadline: () => Effect.succeed(build),
        finishSuccess: () => Effect.succeed(build),
        finishTerminal: () => Effect.succeed(build),
        inspect: (candidate) => Effect.succeed(candidate === workflowId ? build : null),
        markAccepted: () => Effect.succeed(build),
        markAccountingCommitted: () => Effect.succeed(build),
        markPreviewStored: () => Effect.succeed(build),
        recordProviderCost: () => Effect.succeed(build),
        requestCancel: () => Effect.succeed(build),
      },
      recordWorkflowStart: () => Effect.void,
      workflow: {
        create: () => Effect.sync(() => void (providerStarts += 1)),
        terminate: () => Effect.void,
      },
    });
    const layer = DocumentBuild.layerWithoutDependencies.pipe(
      Layer.provide(Layer.succeed(DocumentBuild.Port, port)),
    );
    const program = Effect.gen(function* () {
      const builds = yield* DocumentBuild.Service;
      const continuation = yield* builds.artifactAuthorization(
        { inputDigest: build.inputDigest, workflowId },
        50_000n,
      );
      expect(continuation.build.workflowId).toBe(workflowId);

      const newStart = yield* builds
        .start({
          actionId: ActionId.make("new-document-build-action"),
          agentId: build.agentId,
          authorization: exhaustedAuthorization("free"),
          request: { fileIds: [FileId.make("document-build-source")], format: "pdf" },
          routeId: build.routeId,
          sessionId: build.sessionId,
        })
        .pipe(Effect.result);
      expect(newStart).toMatchObject({ failure: { reason: "allowanceExhausted" } });
      expect(admissions).toBe(0);
      expect(providerStarts).toBe(0);
    });
    yield* program.pipe(Effect.provide(layer));
  }),
);

it.effect("reconciles both Workflow hosts and start accounting before callback execution", () =>
  Effect.gen(function* () {
    const request = yield* DocumentBuild.storedRequestFor("pdf", [resolvedFile("source text")]);
    const workflowId = DocumentBuild.WorkflowId.make("document-build:callback-acceptance");
    const instances = yield* DocumentBuild.cloudflareInstanceIdsFor(workflowId);
    let current: DocumentBuild.Record = {
      ...buildRecord(workflowId, instances, request),
      acceptedAt: null,
      startedAt: null,
      state: "admitted" as const,
    };
    const events: Array<string> = [];
    let workflowStartRecorded = false;
    const port = DocumentBuild.Port.of({
      commitPreviewReadyFollowUp: () => Effect.void,
      commitTerminalFollowUp: () => Effect.void,
      currentAuthorization: () => Effect.succeed(availableAuthorization()),
      discardPendingArtifact: () => Effect.void,
      files: { resolve: () => Effect.succeed([resolvedFile("source text")]) },
      persistence: {
        admit: () => Effect.succeed({ _tag: "Existing" as const, build: current }),
        beginExecution: () =>
          Effect.sync(() => {
            events.push(`begin:${current.state}`);
            current = { ...current, startedAt: productNow, state: "running" };
            return current;
          }),
        commitPublication: () => Effect.succeed(current),
        enforceDeadline: () => Effect.succeed(current),
        finishSuccess: () => Effect.succeed(current),
        finishTerminal: () => Effect.succeed(current),
        inspect: () => Effect.succeed(current),
        markAccepted: () =>
          Effect.sync(() => {
            events.push("accepted");
            current = { ...current, acceptedAt: productNow, state: "accepted" };
            return current;
          }),
        markAccountingCommitted: () => Effect.succeed(current),
        markPreviewStored: () => Effect.succeed(current),
        recordProviderCost: () => Effect.succeed(current),
        requestCancel: () => Effect.succeed(current),
      },
      recordWorkflowStart: () =>
        Effect.sync(() => {
          if (workflowStartRecorded) return;
          workflowStartRecorded = true;
          events.push("workflow-start");
        }),
      workflow: {
        create: () => Effect.sync(() => void events.push("hosts-created")),
        terminate: () => Effect.void,
      },
    });
    const layer = DocumentBuild.layerWithoutDependencies.pipe(
      Layer.provide(Layer.succeed(DocumentBuild.Port, port)),
    );
    yield* DocumentBuild.Service.pipe(
      Effect.flatMap((builds) =>
        builds.beginExecution({ inputDigest: current.inputDigest, workflowId }),
      ),
      Effect.provide(layer),
    );

    expect(events).toEqual(["hosts-created", "accepted", "workflow-start", "begin:accepted"]);
    expect(current.state).toBe("running");
  }),
);

it.effect("replays accepted Workflow-start accounting before entering running", () =>
  Effect.gen(function* () {
    const request = yield* DocumentBuild.storedRequestFor("pdf", [resolvedFile("source text")]);
    const workflowId = DocumentBuild.WorkflowId.make("document-build:accepted-accounting-replay");
    const instances = yield* DocumentBuild.cloudflareInstanceIdsFor(workflowId);
    let current: DocumentBuild.Record = {
      ...buildRecord(workflowId, instances, request),
      acceptedAt: null,
      startedAt: null,
      state: "admitted",
    };
    let accountingAttempts = 0;
    let begins = 0;
    const port = DocumentBuild.Port.of({
      commitPreviewReadyFollowUp: () => Effect.void,
      commitTerminalFollowUp: () => Effect.void,
      currentAuthorization: () => Effect.succeed(availableAuthorization()),
      discardPendingArtifact: () => Effect.void,
      files: { resolve: () => Effect.succeed([resolvedFile("source text")]) },
      persistence: {
        admit: () => Effect.succeed({ _tag: "Existing" as const, build: current }),
        beginExecution: () =>
          Effect.sync(() => {
            begins += 1;
            current = { ...current, startedAt: productNow, state: "running" };
            return current;
          }),
        commitPublication: () => Effect.succeed(current),
        enforceDeadline: () => Effect.succeed(current),
        finishSuccess: () => Effect.succeed(current),
        finishTerminal: () => Effect.succeed(current),
        inspect: () => Effect.succeed(current),
        markAccepted: () =>
          Effect.sync(() => {
            current = { ...current, acceptedAt: productNow, state: "accepted" };
            return current;
          }),
        markAccountingCommitted: () => Effect.succeed(current),
        markPreviewStored: () => Effect.succeed(current),
        recordProviderCost: () => Effect.succeed(current),
        requestCancel: () => Effect.succeed(current),
      },
      recordWorkflowStart: () =>
        Effect.gen(function* () {
          accountingAttempts += 1;
          if (accountingAttempts === 1) {
            return yield* new DocumentBuild.Unavailable({
              cause: "transient accounting outage",
              message: "Workflow-start accounting is unavailable",
              operation: "accounting.workflowStart",
            });
          }
          return undefined;
        }),
      workflow: { create: () => Effect.void, terminate: () => Effect.void },
    });
    const begin = DocumentBuild.Service.pipe(
      Effect.flatMap((builds) =>
        builds.beginExecution({ inputDigest: current.inputDigest, workflowId }),
      ),
      Effect.provide(
        DocumentBuild.layerWithoutDependencies.pipe(
          Layer.provide(Layer.succeed(DocumentBuild.Port, port)),
        ),
      ),
    );

    expect(yield* begin.pipe(Effect.result)).toMatchObject({
      failure: { operation: "accounting.workflowStart" },
    });
    expect(current.state).toBe("accepted");
    expect(yield* begin).toMatchObject({ state: "running" });
    expect(accountingAttempts).toBe(2);
    expect(begins).toBe(1);
  }),
);

it.effect("cancels and settles when admitted source facts change before host acceptance", () =>
  Effect.gen(function* () {
    const request = yield* DocumentBuild.storedRequestFor("pdf", [resolvedFile("source text")]);
    const workflowId = DocumentBuild.WorkflowId.make("document-build:source-changed");
    const instances = yield* DocumentBuild.cloudflareInstanceIdsFor(workflowId);
    let current: DocumentBuild.Record = {
      ...buildRecord(workflowId, instances, request),
      acceptedAt: null,
      startedAt: null,
      state: "admitted",
    };
    let cleanups = 0;
    let followUps = 0;
    const changedFile = {
      ...resolvedFile("changed source text"),
      sha256: FileDigest.make(`sha256:${"d".repeat(64)}`),
    };
    const port = DocumentBuild.Port.of({
      commitPreviewReadyFollowUp: () => Effect.void,
      commitTerminalFollowUp: () => Effect.sync(() => void (followUps += 1)),
      currentAuthorization: () => Effect.succeed(availableAuthorization()),
      discardPendingArtifact: () => Effect.sync(() => void (cleanups += 1)),
      files: { resolve: () => Effect.succeed([changedFile]) },
      persistence: {
        admit: () => Effect.succeed({ _tag: "Existing" as const, build: current }),
        beginExecution: () => Effect.die(new Error("Changed source must not execute")),
        commitPublication: () => Effect.succeed(current),
        enforceDeadline: () => Effect.succeed(current),
        finishSuccess: () => Effect.succeed(current),
        finishTerminal: (_workflowId, _digest, state, safeFailureCode, terminalAt) =>
          Effect.sync(() => {
            current = { ...current, safeFailureCode, state, terminalAt };
            return current;
          }),
        inspect: () => Effect.succeed(current),
        markAccepted: () => Effect.die(new Error("Changed source must not be accepted")),
        markAccountingCommitted: () => Effect.succeed(current),
        markPreviewStored: () => Effect.succeed(current),
        recordProviderCost: () => Effect.succeed(current),
        requestCancel: () => Effect.succeed(current),
      },
      recordWorkflowStart: () => Effect.die(new Error("Changed source must not be accounted")),
      workflow: { create: () => Effect.void, terminate: () => Effect.void },
    });
    const result = yield* DocumentBuild.Service.pipe(
      Effect.flatMap((builds) =>
        builds.beginExecution({ inputDigest: current.inputDigest, workflowId }),
      ),
      Effect.provide(
        DocumentBuild.layerWithoutDependencies.pipe(
          Layer.provide(Layer.succeed(DocumentBuild.Port, port)),
        ),
      ),
      Effect.result,
    );

    expect(result).toMatchObject({ failure: { _tag: "DocumentBuildConflict" } });
    expect(current).toMatchObject({ safeFailureCode: "source-changed", state: "canceled" });
    expect(cleanups).toBe(1);
    expect(followUps).toBe(1);
  }),
);

it.effect("keeps transient source resolution outages retryable without terminal mutation", () =>
  Effect.gen(function* () {
    const request = yield* DocumentBuild.storedRequestFor("pdf", [resolvedFile("source text")]);
    const unavailable = new DocumentBuild.Unavailable({
      cause: "Directory RPC outage",
      message: "Source resolution is temporarily unavailable",
      operation: "files.resolve",
    });
    const admittedId = DocumentBuild.WorkflowId.make("document-build:acceptance-source-outage");
    const admittedInstances = yield* DocumentBuild.cloudflareInstanceIdsFor(admittedId);
    const admitted = revalidationFixture(
      {
        ...buildRecord(admittedId, admittedInstances, request),
        acceptedAt: null,
        startedAt: null,
        state: "admitted",
      },
      Effect.fail(unavailable),
    );
    const runningId = DocumentBuild.WorkflowId.make("document-build:running-source-outage");
    const runningInstances = yield* DocumentBuild.cloudflareInstanceIdsFor(runningId);
    const running = revalidationFixture(
      buildRecord(runningId, runningInstances, request),
      Effect.fail(unavailable),
    );

    const acceptance = yield* DocumentBuild.Service.pipe(
      Effect.flatMap((builds) =>
        builds.reconcileAcceptance(admittedId, admitted.current.inputDigest),
      ),
      Effect.provide(admitted.layer),
      Effect.result,
    );
    const execution = yield* DocumentBuild.Service.pipe(
      Effect.flatMap((builds) =>
        builds.beginExecution({ inputDigest: running.current.inputDigest, workflowId: runningId }),
      ),
      Effect.provide(running.layer),
      Effect.result,
    );

    expect(acceptance).toMatchObject({
      failure: { _tag: "DocumentBuildUnavailable", operation: "files.resolve" },
    });
    expect(execution).toMatchObject({
      failure: { _tag: "DocumentBuildUnavailable", operation: "files.resolve" },
    });
    expect(admitted.current.state).toBe("admitted");
    expect(running.current.state).toBe("running");
    expect(admitted.terminalTransitions()).toBe(0);
    expect(running.terminalTransitions()).toBe(0);
  }),
);

it.effect("cancels promptly when an admitted source permanently disappears", () =>
  Effect.gen(function* () {
    const request = yield* DocumentBuild.storedRequestFor("pdf", [resolvedFile("source text")]);
    const workflowId = DocumentBuild.WorkflowId.make("document-build:source-disappeared");
    const instances = yield* DocumentBuild.cloudflareInstanceIdsFor(workflowId);
    const fixture = revalidationFixture(
      {
        ...buildRecord(workflowId, instances, request),
        acceptedAt: null,
        startedAt: null,
        state: "admitted",
      },
      Effect.fail(new DocumentBuild.SourceChanged({ message: "The source file no longer exists" })),
    );

    const result = yield* DocumentBuild.Service.pipe(
      Effect.flatMap((builds) =>
        builds.reconcileAcceptance(workflowId, fixture.current.inputDigest),
      ),
      Effect.provide(fixture.layer),
    );

    expect(result).toMatchObject({ safeFailureCode: "source-changed", state: "canceled" });
    expect(fixture.terminalTransitions()).toBe(1);
  }),
);

it.effect("reconciles an AcceptancePending row before fresh source resolution", () =>
  Effect.gen(function* () {
    const actionId = ActionId.make("admitted-document-build-action");
    const workflowId = yield* DocumentBuild.workflowIdFor(userId, actionId);
    const request = yield* DocumentBuild.storedRequestFor("pdf", [resolvedFile("source text")]);
    const instances = yield* DocumentBuild.cloudflareInstanceIdsFor(workflowId);
    const fixture = revalidationFixture(
      {
        ...buildRecord(workflowId, instances, request),
        acceptedAt: null,
        startedAt: null,
        state: "admitted",
      },
      Effect.fail(
        new DocumentBuild.SourceChanged({ message: "The source disappeared after admission" }),
      ),
    );

    const result = yield* DocumentBuild.Service.pipe(
      Effect.flatMap((builds) =>
        builds.start({
          actionId,
          agentId: AgentId.make("document-build-agent"),
          authorization: availableAuthorization(),
          request: { fileIds: [FileId.make("document-build-source")], format: "pdf" },
          routeId: ConversationRouteId.make("document-build-route"),
          sessionId: SessionId.make("document-build-session"),
        }),
      ),
      Effect.provide(fixture.layer),
    );

    expect(result).toMatchObject({
      _tag: "Replayed",
      build: { safeFailureCode: "source-changed", state: "canceled" },
    });
    expect(fixture.hostCreations()).toBe(0);
  }),
);

it.effect("retries terminal cleanup and follow-up after canceled truth is already durable", () =>
  Effect.gen(function* () {
    const request = yield* DocumentBuild.storedRequestFor("pdf", [resolvedFile("source text")]);
    const workflowId = DocumentBuild.WorkflowId.make("document-build:cancel-settlement");
    const instances = yield* DocumentBuild.cloudflareInstanceIdsFor(workflowId);
    const canceled = {
      ...buildRecord(workflowId, instances, request),
      safeFailureCode: "cancel-requested",
      state: "canceled" as const,
      terminalAt: productNow,
    };
    let discardAttempts = 0;
    let followUps = 0;
    const port = DocumentBuild.Port.of({
      commitPreviewReadyFollowUp: () => Effect.void,
      commitTerminalFollowUp: () => Effect.sync(() => void (followUps += 1)),
      currentAuthorization: () => Effect.succeed(availableAuthorization()),
      discardPendingArtifact: () =>
        Effect.gen(function* () {
          discardAttempts += 1;
          if (discardAttempts === 1) {
            return yield* new DocumentBuild.Unavailable({
              cause: "transient R2 failure",
              message: "Pending artifact cleanup is unavailable",
              operation: "artifact.discard",
            });
          }
          return undefined;
        }),
      files: { resolve: () => Effect.succeed([resolvedFile("source text")]) },
      persistence: {
        admit: () => Effect.succeed({ _tag: "Existing" as const, build: canceled }),
        beginExecution: () => Effect.succeed(canceled),
        commitPublication: () => Effect.succeed(canceled),
        enforceDeadline: () => Effect.succeed(canceled),
        finishSuccess: () => Effect.succeed(canceled),
        finishTerminal: () => Effect.succeed(canceled),
        inspect: () => Effect.succeed(canceled),
        markAccepted: () => Effect.succeed(canceled),
        markAccountingCommitted: () => Effect.succeed(canceled),
        markPreviewStored: () => Effect.succeed(canceled),
        recordProviderCost: () => Effect.succeed(canceled),
        requestCancel: () => Effect.succeed(canceled),
      },
      recordWorkflowStart: () => Effect.void,
      workflow: { create: () => Effect.void, terminate: () => Effect.void },
    });
    const layer = DocumentBuild.layerWithoutDependencies.pipe(
      Layer.provide(Layer.succeed(DocumentBuild.Port, port)),
    );
    const cancel = DocumentBuild.Service.pipe(
      Effect.flatMap((builds) => builds.cancel(workflowId, canceled.userId)),
      Effect.provide(layer),
    );

    expect(yield* cancel.pipe(Effect.result)).toMatchObject({
      failure: { _tag: "DocumentBuildUnavailable" },
    });
    expect(yield* cancel).toMatchObject({ _tag: "Terminal", build: { state: "canceled" } });
    expect(discardAttempts).toBe(2);
    expect(followUps).toBe(1);
  }),
);

it.effect("replays idempotent cleanup after a transient terminal follow-up failure", () =>
  Effect.gen(function* () {
    const request = yield* DocumentBuild.storedRequestFor("pdf", [resolvedFile("source text")]);
    const workflowId = DocumentBuild.WorkflowId.make("document-build:follow-up-settlement");
    const instances = yield* DocumentBuild.cloudflareInstanceIdsFor(workflowId);
    const canceled = {
      ...buildRecord(workflowId, instances, request),
      safeFailureCode: "cancel-requested",
      state: "canceled" as const,
      terminalAt: productNow,
    };
    let cleanups = 0;
    let followUpAttempts = 0;
    const port = DocumentBuild.Port.of({
      commitPreviewReadyFollowUp: () => Effect.void,
      commitTerminalFollowUp: () =>
        Effect.gen(function* () {
          followUpAttempts += 1;
          if (followUpAttempts === 1) {
            return yield* new DocumentBuild.Unavailable({
              cause: "transient Agent RPC failure",
              message: "Terminal follow-up is unavailable",
              operation: "followUp.submit",
            });
          }
          return undefined;
        }),
      currentAuthorization: () => Effect.succeed(availableAuthorization()),
      discardPendingArtifact: () => Effect.sync(() => void (cleanups += 1)),
      files: { resolve: () => Effect.succeed([resolvedFile("source text")]) },
      persistence: {
        admit: () => Effect.succeed({ _tag: "Existing" as const, build: canceled }),
        beginExecution: () => Effect.succeed(canceled),
        commitPublication: () => Effect.succeed(canceled),
        enforceDeadline: () => Effect.succeed(canceled),
        finishSuccess: () => Effect.succeed(canceled),
        finishTerminal: () => Effect.succeed(canceled),
        inspect: () => Effect.succeed(canceled),
        markAccepted: () => Effect.succeed(canceled),
        markAccountingCommitted: () => Effect.succeed(canceled),
        markPreviewStored: () => Effect.succeed(canceled),
        recordProviderCost: () => Effect.succeed(canceled),
        requestCancel: () => Effect.succeed(canceled),
      },
      recordWorkflowStart: () => Effect.void,
      workflow: { create: () => Effect.void, terminate: () => Effect.void },
    });
    const layer = DocumentBuild.layerWithoutDependencies.pipe(
      Layer.provide(Layer.succeed(DocumentBuild.Port, port)),
    );
    const cancel = DocumentBuild.Service.pipe(
      Effect.flatMap((builds) => builds.cancel(workflowId, canceled.userId)),
      Effect.provide(layer),
    );

    expect(yield* cancel.pipe(Effect.result)).toMatchObject({
      failure: { _tag: "DocumentBuildUnavailable", operation: "followUp.submit" },
    });
    expect(yield* cancel).toMatchObject({ _tag: "Terminal", build: { state: "canceled" } });
    expect(cleanups).toBe(2);
    expect(followUpAttempts).toBe(2);
  }),
);

const resolvedFile = (normalizedText: string): DocumentBuild.ResolvedFile => ({
  byteLength: BigInt(new TextEncoder().encode(normalizedText).byteLength),
  fileId: FileId.make("document-build-source"),
  fileName: "Source.txt",
  mediaType: "text/plain",
  normalizedText,
  sha256: FileDigest.make(`sha256:${"a".repeat(64)}`),
});

const revalidationFixture = (
  initial: DocumentBuild.Record,
  resolution: Effect.Effect<
    ReadonlyArray<DocumentBuild.ResolvedFile>,
    DocumentBuild.SourceChanged | DocumentBuild.Unavailable
  >,
) => {
  let current = initial;
  let hostCreations = 0;
  let terminalTransitions = 0;
  const port = DocumentBuild.Port.of({
    commitPreviewReadyFollowUp: () => Effect.void,
    commitTerminalFollowUp: () => Effect.void,
    currentAuthorization: () => Effect.succeed(availableAuthorization()),
    discardPendingArtifact: () => Effect.void,
    files: { resolve: () => resolution },
    persistence: {
      admit: () => Effect.succeed({ _tag: "Existing" as const, build: current }),
      beginExecution: () => Effect.succeed(current),
      commitPublication: () => Effect.succeed(current),
      enforceDeadline: () => Effect.succeed(current),
      finishSuccess: () => Effect.succeed(current),
      finishTerminal: (_workflowId, _digest, state, safeFailureCode, terminalAt) =>
        Effect.sync(() => {
          terminalTransitions += 1;
          current = { ...current, safeFailureCode, state, terminalAt };
          return current;
        }),
      inspect: () => Effect.succeed(current),
      markAccepted: () => Effect.die(new Error("Source outage must not be accepted")),
      markAccountingCommitted: () => Effect.succeed(current),
      markPreviewStored: () => Effect.succeed(current),
      recordProviderCost: () => Effect.succeed(current),
      requestCancel: () => Effect.succeed(current),
    },
    recordWorkflowStart: () => Effect.void,
    workflow: {
      create: () => Effect.sync(() => void (hostCreations += 1)),
      terminate: () => Effect.void,
    },
  });
  return {
    get current() {
      return current;
    },
    layer: DocumentBuild.layerWithoutDependencies.pipe(
      Layer.provide(Layer.succeed(DocumentBuild.Port, port)),
    ),
    hostCreations: () => hostCreations,
    terminalTransitions: () => terminalTransitions,
  };
};

const productNow = new Date("2026-08-28T12:00:00.000Z");
const userId = UserId.make("document-build-user");
const allowancePeriodId = AllowancePeriodId.make("document-build-period");

const exhaustedAuthorization = (
  plan: "adventurer" | "free" = "adventurer",
  exhausted = true,
): AuthorizationContext => ({
  allowance: {
    _tag: "Metered",
    allowancePeriodId,
    endsAt: new Date("2026-09-28T12:00:00.000Z"),
    plan,
    planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    startsAt: productNow,
    usage: exhausted
      ? [
          {
            allowanceKind: "vendorUsdMicros",
            quantity: policyFor(currentLaunchPolicy, plan).allowanceLimits.vendorUsdMicros,
          },
        ]
      : [],
  },
  approval: null,
  authority: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("document-build-auth"),
    expiresAt: new Date("2026-09-28T12:00:00.000Z"),
    userId,
  },
  deletionAccess: { _tag: "DeletionAccessAvailable" },
  gmailConnection: null,
  integrationConnections: [],
  liveFacts: emptyLiveResourceFacts,
  now: productNow,
  originatingAuthority: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("document-build-auth"),
  },
  requestVendorUsdMicros: 0n,
  resourceOwnerUserId: userId,
  subscription: { plan, planPolicyVersion: PlanPolicyVersion.make("launch-v1") },
  user: { _tag: "ActiveUser", userId },
});

const availableAuthorization = (): AuthorizationContext =>
  exhaustedAuthorization("adventurer", false);

const buildRecord = (
  workflowId: DocumentBuild.WorkflowId,
  instances: {
    readonly main: DocumentBuild.CloudflareInstanceId;
    readonly timer: DocumentBuild.CloudflareInstanceId;
  },
  request: DocumentBuild.StoredRequest,
): DocumentBuild.Record => ({
  acceptedAt: productNow,
  accountingCommittedAt: null,
  actionId: ActionId.make("admitted-document-build-action"),
  admittedAt: productNow,
  agentId: AgentId.make("document-build-agent"),
  allowancePeriodId,
  artifactAccountedAt: null,
  artifactContentId: null,
  cancelRequestedAt: null,
  capabilityCatalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
  cloudflareInstanceId: instances.main,
  cloudflareTimerInstanceId: instances.timer,
  costEvidence: null,
  deadlineAt: new Date("2026-08-28T13:00:00.000Z"),
  inputDigest: DocumentBuild.InputDigest.make("b".repeat(64)),
  manifestVersion: null,
  modelAccessPolicyVersion: ModelAccessPolicyVersion.make("launch-v1"),
  modelRoute: ManagedModelRoute.make("@cf/deepseek-ai/deepseek-v4-flash-0731"),
  originatingAuthority: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("document-build-auth"),
  },
  planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
  previewStoredAt: null,
  publicationCommittedAt: null,
  request,
  resourcePriceVersion: ResourcePriceVersion.make("resource-prices-2026-08-22"),
  routeId: ConversationRouteId.make("document-build-route"),
  safeFailureCode: null,
  sessionId: SessionId.make("document-build-session"),
  startedAt: productNow,
  providerCostRecordedAt: null,
  state: "running",
  terminalAt: null,
  userId,
  workflowId,
});
