/* oxlint-disable eslint/no-underscore-dangle, vitest/no-standalone-expect -- Assertions execute inside Effect tests and inspect Effect's standard outcome tag. */
/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect, typescript/consistent-return -- Fixed product timestamps make ordering deterministic; generator failures use Effect's typed channel. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each test owns its service layer. */
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
import { ContentId } from "../domain/client-content";
import { DocumentArtifact } from "../domain/document-artifact";
import { FileDigest } from "../domain/file-content";
import { FileId } from "../domain/file";
import { ManagedModelRoute } from "../domain/model-access-policy";
import { DocumentBuild } from "./document-build";
import { DocumentBuildDocument } from "./document-build-document";
import {
  ArtifactIntegrityFailure,
  ArtifactStoreUnavailable,
  type CostEvidence,
  DocumentCleanupUnavailable,
  type StoredArtifactMetadata,
} from "./document-generation";

it.effect("keeps one validated artifact pending until evidence and publication are durable", () => {
  const fixture = publicationFixture();
  return Effect.gen(function* () {
    const documents = yield* DocumentBuildDocument.Service;
    const completed = yield* documents.generate(fixture.build());

    expect(completed.build.state).toBe("success");
    expect(fixture.computeCalls()).toBe(1);
    expect(fixture.stored()?.artifact.content.contentId).toBe(
      `document:workflow:${fixture.build().workflowId}`,
    );
    expect(fixture.stored()?.retention).toBe("accounted");
    expect(fixture.events()).toEqual([
      "authorize",
      "compute",
      "provider-cost",
      "authorize",
      "put:pending",
      "preview:pending",
      "provider-cost",
      "accounting",
      "authorize",
      "publication",
      "generated-document",
      "account",
      "cleanup",
      "success",
    ]);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("stops before provider work when current durable authority is lost", () => {
  const fixture = publicationFixture({ denyAuthorization: true });
  return Effect.gen(function* () {
    const documents = yield* DocumentBuildDocument.Service;
    const result = yield* documents.generate(fixture.build()).pipe(Effect.result);

    expect(result).toMatchObject({
      failure: { reason: "authorizationEnded" },
    });
    expect(fixture.computeCalls()).toBe(0);
    expect(fixture.stored()).toBeNull();
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("retains incurred provider cost before failed artifact validation", () => {
  const fixture = publicationFixture({ invalidValidation: true });
  return Effect.gen(function* () {
    const documents = yield* DocumentBuildDocument.Service;
    const result = yield* documents.generate(fixture.build()).pipe(Effect.result);

    expect(result).toMatchObject({ failure: { reason: "invalidArtifact" } });
    expect(fixture.events()).toContain("provider-cost");
    expect(fixture.events()).not.toContain("generated-document");
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("does not pin ProvenNoUse for a retryable outage before later incurred compute", () => {
  const fixture = publicationFixture({ computeOutageFirst: true });
  return Effect.gen(function* () {
    const documents = yield* DocumentBuildDocument.Service;
    const first = yield* documents.generate(fixture.build()).pipe(Effect.result);

    expect(first).toMatchObject({ failure: { reason: "recoveryPending" } });
    expect(fixture.build().costEvidence).toBeNull();
    expect(fixture.recordedCosts()).toEqual([]);

    const completed = yield* documents.generate(fixture.build());
    expect(completed.build.state).toBe("success");
    expect(fixture.recordedCosts().every((evidence) => evidence._tag === "Incurred")).toBe(true);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("retains incurred provider cost when authority ends after provider use", () => {
  const fixture = publicationFixture({ computeAuthorizationFailureAfterUse: true });
  return Effect.gen(function* () {
    const documents = yield* DocumentBuildDocument.Service;
    const result = yield* documents.generate(fixture.build()).pipe(Effect.result);

    expect(result).toMatchObject({ failure: { reason: "authorizationEnded" } });
    expect(fixture.recordedCosts()).toHaveLength(1);
    expect(fixture.recordedCosts()[0]).toMatchObject({ _tag: "Incurred" });
    expect(fixture.events()).not.toContain("generated-document");
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("resumes pending publication without starting a second compute attempt", () => {
  const fixture = publicationFixture({ accountFailures: 1 });
  return Effect.gen(function* () {
    const documents = yield* DocumentBuildDocument.Service;
    const first = yield* documents.generate(fixture.build()).pipe(Effect.result);
    expect(first).toMatchObject({ failure: { operation: "account" } });
    expect(fixture.build().state).toBe("publication_committed");
    expect(fixture.stored()?.retention).toBe("pending");

    const completed = yield* documents.recoverPublication(fixture.build());
    expect(completed.build.state).toBe("success");
    expect(fixture.computeCalls()).toBe(1);
    expect(fixture.stored()?.retention).toBe("accounted");
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("retries every post-publication step without rendering or republishing", () => {
  const fixtures = [
    publicationFixture({ generatedDocumentFailures: 1 }),
    publicationFixture({ cleanupFailures: 1 }),
    publicationFixture({ successFailures: 1 }),
  ];
  return Effect.forEach(fixtures, (fixture) =>
    Effect.gen(function* () {
      const documents = yield* DocumentBuildDocument.Service;
      const first = yield* documents.generate(fixture.build()).pipe(Effect.result);
      expect(first).toMatchObject({ failure: {} });
      expect(fixture.build().state).toBe("publication_committed");

      const completed = yield* documents.recoverPublication(fixture.build());
      expect(completed.build.state).toBe("success");
      expect(fixture.computeCalls()).toBe(1);
      expect(fixture.publicationCalls()).toBe(1);
    }).pipe(Effect.provide(fixture.layer)),
  );
});

it.effect("records zero User Usage when cancellation wins before publication claim", () => {
  const fixture = publicationFixture({ cancelAtPublication: "before" });
  return Effect.gen(function* () {
    const documents = yield* DocumentBuildDocument.Service;
    const result = yield* documents.generate(fixture.build()).pipe(Effect.result);

    expect(result).toMatchObject({ failure: { operation: "publish" } });
    expect(fixture.events()).not.toContain("generated-document");
    expect(fixture.stored()).toBeNull();
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("does not let cancellation overturn a committed publication claim", () => {
  const fixture = publicationFixture({ cancelAtPublication: "after" });
  return Effect.gen(function* () {
    const documents = yield* DocumentBuildDocument.Service;
    const completed = yield* documents.generate(fixture.build());

    expect(completed.build.state).toBe("success");
    expect(fixture.events()).toContain("cancel-lost-to-publication");
    expect(fixture.events()).toContain("generated-document");
  }).pipe(Effect.provide(fixture.layer));
});

const now = new Date("2026-08-28T12:00:00.000Z");

const publicationFixture = (
  options: {
    readonly accountFailures?: number;
    readonly cancelAtPublication?: "after" | "before";
    readonly cleanupFailures?: number;
    readonly computeAuthorizationFailureAfterUse?: boolean;
    readonly computeOutageFirst?: boolean;
    readonly denyAuthorization?: boolean;
    readonly generatedDocumentFailures?: number;
    readonly invalidValidation?: boolean;
    readonly successFailures?: number;
  } = {},
) => {
  let current = buildRecord();
  let retained: StoredArtifactMetadata | null = null;
  let computeCalls = 0;
  let accountFailures = options.accountFailures ?? 0;
  let cleanupFailures = options.cleanupFailures ?? 0;
  let generatedDocumentFailures = options.generatedDocumentFailures ?? 0;
  let publicationCalls = 0;
  let successFailures = options.successFailures ?? 0;
  const events: Array<string> = [];
  const recordedCosts: Array<CostEvidence> = [];
  const contentId = ContentId.make(`document:workflow:${current.workflowId}`);
  const cost = {
    _tag: "Incurred" as const,
    allowancePeriodId: current.allowancePeriodId,
    basis: "observed" as const,
    providerOperationId: "document-build-provider-operation",
    usdMicros: 10n,
  };
  const port = DocumentBuildDocument.Port.of({
    artifacts: {
      account: () =>
        Effect.gen(function* () {
          events.push("account");
          if (accountFailures > 0) {
            accountFailures -= 1;
            return yield* new ArtifactStoreUnavailable({
              cause: "R2 unavailable",
              message: "R2 unavailable",
              operation: "account",
            });
          }
          if (retained === null) {
            return yield* new ArtifactIntegrityFailure({
              contentId,
              message: "The pending artifact is missing",
            });
          }
          retained = { ...retained, retention: "accounted" };
        }),
      delete: () => Effect.sync(() => void (retained = null)),
      inspect: () => Effect.sync(() => retained),
      put: (artifact) =>
        Effect.sync(() => {
          retained = artifact;
          events.push(`put:${artifact.retention}`);
        }),
      readBytes: () => Effect.succeed(new Uint8Array([1, 2, 3])),
    },
    authorize: (build) =>
      Effect.gen(function* () {
        events.push("authorize");
        if (options.denyAuthorization === true) {
          return yield* Effect.fail({
            _tag: "Denied",
            reason: "authorityRevoked",
            resetAt: new Date("2026-09-28T12:00:00.000Z"),
          } as const);
        }
        return build;
      }),
    commitAccounting: (build, retainedContentId, retainedCost) =>
      Effect.sync(() => {
        events.push("accounting");
        if (build.accountingCommittedAt !== null) return build;
        current = {
          ...build,
          accountingCommittedAt: now,
          artifactContentId: retainedContentId,
          costEvidence: retainedCost,
        };
        return current;
      }),
    commitPublication: (build, retainedContentId) =>
      Effect.gen(function* () {
        events.push("publication");
        if (build.publicationCommittedAt !== null) return build;
        publicationCalls += 1;
        if (options.cancelAtPublication === "before") {
          current = {
            ...build,
            safeFailureCode: "cancel-requested",
            state: "canceled",
            terminalAt: now,
          };
          return yield* new DocumentBuild.Conflict({
            message: "Cancellation won before publication",
            workflowId: build.workflowId,
          });
        }
        current = {
          ...build,
          artifactContentId: retainedContentId,
          publicationCommittedAt: now,
          state: "publication_committed",
        };
        if (options.cancelAtPublication === "after") events.push("cancel-lost-to-publication");
        return current;
      }),
    compute: {
      dispose: () =>
        Effect.gen(function* () {
          events.push("cleanup");
          if (cleanupFailures > 0) {
            cleanupFailures -= 1;
            return yield* new DocumentCleanupUnavailable({
              cause: "Sandbox unavailable",
              contentId,
              message: "Sandbox unavailable",
            });
          }
        }),
      generate: () =>
        Effect.sync(() => {
          events.push("compute");
          computeCalls += 1;
          if (options.computeOutageFirst === true && computeCalls === 1) {
            return {
              _tag: "AttemptUnavailable" as const,
              cost: { _tag: "ProvenNoUse" as const },
              evidence: "Attempt store unavailable before provider use",
            };
          }
          if (options.computeAuthorizationFailureAfterUse === true) {
            return {
              _tag: "AuthorizationFailure" as const,
              cost,
              failure: {
                _tag: "Denied" as const,
                reason: "authorityRevoked" as const,
                resetAt: null,
              },
            };
          }
          return {
            _tag: "Completed" as const,
            bytes: new Uint8Array([1, 2, 3]),
            cost,
            renderedPageCount: 1,
          };
        }),
      inspect: () => Effect.succeed(null),
    },
    finishSuccess: (build, retainedContentId) =>
      Effect.gen(function* () {
        events.push("success");
        if (successFailures > 0) {
          successFailures -= 1;
          return yield* new DocumentBuild.Unavailable({
            cause: "PostgreSQL unavailable",
            message: "PostgreSQL unavailable",
            operation: "finishSuccess",
          });
        }
        current = {
          ...build,
          artifactAccountedAt: now,
          artifactContentId: retainedContentId,
          state: "success",
          terminalAt: now,
        };
        return current;
      }),
    markPreviewStored: (build, retainedContentId) =>
      Effect.sync(() => {
        events.push(`preview:${retained?.retention ?? "missing"}`);
        if (build.artifactContentId !== null) return build;
        current = {
          ...build,
          artifactContentId: retainedContentId,
          previewStoredAt: now,
          state: "preview_stored",
        };
        return current;
      }),
    maximumComputeUsdMicros: 100n,
    recordGeneratedDocument: () =>
      Effect.gen(function* () {
        events.push("generated-document");
        if (generatedDocumentFailures > 0) {
          generatedDocumentFailures -= 1;
          return yield* new DocumentBuildDocument.Unavailable({
            cause: "Usage unavailable",
            message: "Usage unavailable",
            operation: "accounting",
            reason: "storageUnavailable",
          });
        }
      }),
    recordProviderCost: (build, _contentId, retainedCost) =>
      Effect.sync(() => {
        events.push("provider-cost");
        recordedCosts.push(retainedCost);
        current = { ...build, costEvidence: retainedCost, providerCostRecordedAt: now };
      }),
    validator: {
      validate: (retainedContentId, format, bytes, pages) =>
        options.invalidValidation === true
          ? Effect.fail(
              new DocumentArtifact.InvalidGeneratedArtifact({
                contentId: retainedContentId,
                message: "invalid generated document",
                reason: "invalidDocument",
              }),
            )
          : DocumentArtifact.make(
              retainedContentId,
              format,
              bytes.byteLength,
              pages,
              "f".repeat(64),
            ),
    },
  });
  return {
    build: () => current,
    computeCalls: () => computeCalls,
    events: () => events,
    layer: DocumentBuildDocument.layerWithoutDependencies.pipe(
      Layer.provide(Layer.succeed(DocumentBuildDocument.Port, port)),
    ),
    publicationCalls: () => publicationCalls,
    recordedCosts: () => recordedCosts,
    stored: () => retained,
  };
};

const buildRecord = (): DocumentBuild.Record => ({
  acceptedAt: now,
  accountingCommittedAt: null,
  actionId: ActionId.make("document-build-action"),
  admittedAt: now,
  agentId: AgentId.make("document-build-agent"),
  allowancePeriodId: AllowancePeriodId.make("document-build-period"),
  artifactAccountedAt: null,
  artifactContentId: null,
  cancelRequestedAt: null,
  capabilityCatalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
  cloudflareInstanceId: DocumentBuild.CloudflareInstanceId.make("document-build-instance"),
  cloudflareTimerInstanceId: DocumentBuild.CloudflareInstanceId.make("document-build-timer"),
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
  request: DocumentBuild.StoredRequest.make({
    fileSnapshots: [
      {
        byteLength: 12n,
        fileId: FileId.make("document-source"),
        mediaType: "text/plain",
        sha256: FileDigest.make(`sha256:${"c".repeat(64)}`),
      },
    ],
    format: "pdf",
    source: { pages: [{ lines: ["hello"], title: "Source" }] },
  }),
  resourcePriceVersion: ResourcePriceVersion.make("resource-prices-2026-08-22"),
  routeId: ConversationRouteId.make("document-build-route"),
  safeFailureCode: null,
  sessionId: SessionId.make("document-build-session"),
  startedAt: now,
  providerCostRecordedAt: null,
  state: "running",
  terminalAt: null,
  userId: UserId.make("document-build-user"),
  workflowId: DocumentBuild.WorkflowId.make("document-build:publication"),
});
