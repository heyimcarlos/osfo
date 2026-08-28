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
      failure: {
        _tag: "DocumentBuildUnavailable",
        operation: "files.combineSource",
      },
    });
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
      currentAuthorization: () => Effect.succeed(exhaustedAuthorization()),
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
          authorization: exhaustedAuthorization(),
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

const resolvedFile = (normalizedText: string): DocumentBuild.ResolvedFile => ({
  byteLength: BigInt(new TextEncoder().encode(normalizedText).byteLength),
  fileId: FileId.make("document-build-source"),
  fileName: "Source.txt",
  mediaType: "text/plain",
  normalizedText,
  sha256: FileDigest.make(`sha256:${"a".repeat(64)}`),
});

const productNow = new Date("2026-08-28T12:00:00.000Z");
const userId = UserId.make("document-build-user");
const allowancePeriodId = AllowancePeriodId.make("document-build-period");

const exhaustedAuthorization = (): AuthorizationContext => ({
  allowance: {
    _tag: "Metered",
    allowancePeriodId,
    endsAt: new Date("2026-09-28T12:00:00.000Z"),
    plan: "adventurer",
    planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    startsAt: productNow,
    usage: [
      {
        allowanceKind: "workflowStarts",
        quantity: policyFor(currentLaunchPolicy, "adventurer").allowanceLimits.workflowStarts,
      },
    ],
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
  subscription: { plan: "adventurer", planPolicyVersion: PlanPolicyVersion.make("launch-v1") },
  user: { _tag: "ActiveUser", userId },
});

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
  state: "running",
  terminalAt: null,
  userId,
  workflowId,
});
