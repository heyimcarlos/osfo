/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effects returned to it.effect. */
/* oxlint-disable effecttsgo/global-date -- Fixed dates are immutable citation evidence. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect owns its isolated service Layer. */
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";

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
import { ManagedModelRoute } from "../domain/model-access-policy";
import { emptyLiveResourceFacts, type AuthorizationContext } from "./authorization";
import {
  ArtifactIntegrityFailure,
  ArtifactStoreUnavailable,
  type StoredArtifactMetadata,
} from "./document-generation";
import { ResearchCollector } from "./research-collector";
import { ResearchReportDocument } from "./research-report-document";
import { ResearchReport } from "./research-report";
import { ResearchSynthesis } from "./research-synthesis";

const retained: ReadonlyArray<ResearchCollector.RetainedSource> = [
  {
    content: "PRIVATE RAW BODY. The measured result improved by twelve percent.",
    source: ResearchCollector.ManifestSource.make({
      contentDigest: ResearchReport.InputDigest.make("d".repeat(64)),
      contentKey: "users/report/source.json",
      fetchedAt: new Date("2026-08-27T12:05:00.000Z"),
      sourceId: "S1",
      title: "Measured result",
      url: "https://example.com/result",
    }),
  },
];

const synthesis = ResearchSynthesis.Result.make({
  conclusion: [claim("The measured improvement supports the conclusion.")],
  sections: [{ heading: "Analysis", materialClaims: [claim("The result improved.")] }],
  summary: [claim("The source reports a measured improvement.")],
  title: "Measured improvement report",
});

const documentFailure = (reason: ResearchReportDocument.Unavailable["reason"]) =>
  new ResearchReportDocument.Unavailable({
    cause: reason,
    message: reason,
    operation: "compute",
    reason,
  });

it.effect("renders validated synthesis and generates references from retained truth", () =>
  Effect.gen(function* () {
    const source = yield* ResearchReportDocument.documentSourceFor(synthesis, retained);
    const rendered = source.pages.flatMap(({ lines }) => lines).join("\n");
    expect(rendered).toContain("The result improved. [S1]");
    expect(rendered).toContain("Evidence: “measured result improved” [S1]");
    expect(rendered).toContain("https://example.com/result");
    expect(rendered).toContain("d".repeat(64));
    expect(rendered).not.toContain("PRIVATE RAW BODY");
    expect(source.pages.map(({ title }) => title)).toEqual([
      "Measured improvement report — Executive summary",
      "Analysis",
      "Conclusion",
      "References",
    ]);
  }),
);

it.effect("chunks cited material into pages of at most thirty lines", () =>
  Effect.gen(function* () {
    const claims = Array.from({ length: 10 }, (_, index) =>
      claim(`Material claim ${index} ${"analysis ".repeat(20)}`),
    );
    const source = yield* ResearchReportDocument.documentSourceFor(
      ResearchSynthesis.Result.make({
        conclusion: [claim("Conclusion claim")],
        sections: [{ heading: "Maximum section", materialClaims: claims }],
        summary: [claim("Summary claim")],
        title: "Paginated report",
      }),
      retained,
    );

    expect(source.pages.every(({ lines }) => lines.length <= 30)).toBe(true);
    expect(source.pages.length).toBeGreaterThan(4);
  }),
);

it.effect("fails deterministically when bounded synthesis cannot fit twenty pages", () =>
  Effect.gen(function* () {
    const claims = Array.from({ length: 10 }, (_, index) => ({
      evidence: Array.from({ length: 6 }, () => ({
        quote: "measured result improved",
        sourceId: "S1",
      })),
      statement: `Material claim ${index} ${"analysis ".repeat(190)}`,
    }));
    const result = yield* ResearchReportDocument.documentSourceFor(
      ResearchSynthesis.Result.make({
        conclusion: claims.slice(0, 5),
        sections: Array.from({ length: 8 }, (_, index) => ({
          heading: `Section ${index}`,
          materialClaims: claims,
        })),
        summary: claims.slice(0, 5),
        title: "Oversized bounded report",
      }),
      retained,
    ).pipe(Effect.result);

    expect(result).toMatchObject({
      failure: { _tag: "ResearchReportDocumentUnavailable", operation: "validate" },
    });
  }),
);

it.effect("maps every closed document outcome to the exact product consequence", () =>
  Effect.sync(() => {
    expect(
      ResearchReportDocument.terminalDispositionFor(documentFailure("authorizationEnded")),
    ).toEqual({ _tag: "Canceled", safeFailureCode: "authority-ended" });
    for (const reason of ["costLimitExceeded", "intentConflict", "invalidArtifact"] as const) {
      expect(ResearchReportDocument.terminalDispositionFor(documentFailure(reason))).toEqual({
        _tag: "Failure",
        safeFailureCode: `document-${reason}`,
      });
    }
    expect(
      ResearchReportDocument.terminalDispositionFor(documentFailure("recoveryPending")),
    ).toEqual({ _tag: "RecoveryPending" });
    expect(
      ResearchReportDocument.terminalDispositionFor(documentFailure("storageUnavailable")),
    ).toBeNull();
  }),
);

it.effect("retries R2 accounting from publication_committed without a second render", () => {
  const fixture = publicationFixture({ accountFailures: 1 });
  return Effect.gen(function* () {
    const documents = yield* ResearchReportDocument.Service;
    const first = yield* documents.generate(fixture.report(), collection).pipe(Effect.result);
    expect(first).toMatchObject({ failure: { operation: "account" } });
    expect(fixture.report().state).toBe("publication_committed");
    expect(fixture.computeCalls()).toBe(1);
    const pending = fixture.stored();
    expect(pending?.retention).toBe("pending");
    if (pending !== null) {
      const unreadable = yield* fixture.port.artifacts.readBytes(pending).pipe(Effect.result);
      expect(Result.isFailure(unreadable)).toBe(true);
    }

    const retried = yield* documents.generate(fixture.report(), collection);
    expect(retried.report.state).toBe("success");
    expect(fixture.computeCalls()).toBe(1);
    expect(fixture.accountAttempts()).toBe(2);
    expect(fixture.usageFacts()).toHaveLength(1);
    const readable = fixture.stored();
    if (readable !== null) {
      expect(yield* fixture.port.artifacts.readBytes(readable)).toEqual(new Uint8Array([1, 2, 3]));
    }
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("retries Usage after readable publication and commits it exactly once", () => {
  const fixture = publicationFixture({ usageFailures: 1 });
  return Effect.gen(function* () {
    const documents = yield* ResearchReportDocument.Service;
    const first = yield* documents.generate(fixture.report(), collection).pipe(Effect.result);
    expect(first).toMatchObject({ failure: { operation: "recordUsage" } });
    expect(fixture.report().state).toBe("publication_committed");
    expect(fixture.stored()?.retention).toBe("accounted");

    const retried = yield* documents.generate(fixture.report(), collection);
    expect(retried.report.state).toBe("success");
    expect(fixture.computeCalls()).toBe(1);
    expect(fixture.usageAttempts()).toBe(2);
    expect(fixture.usageFacts()).toHaveLength(1);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("replays a completed Usage fact when terminal success persistence is unavailable", () => {
  const fixture = publicationFixture({ successFailures: 1 });
  return Effect.gen(function* () {
    const documents = yield* ResearchReportDocument.Service;
    const first = yield* documents.generate(fixture.report(), collection).pipe(Effect.result);
    expect(first).toMatchObject({ failure: { operation: "publish" } });
    expect(fixture.report().state).toBe("publication_committed");
    expect(fixture.usageFacts()).toHaveLength(1);

    const retried = yield* documents.generate(fixture.report(), collection);
    expect(retried.report.state).toBe("success");
    expect(fixture.usageAttempts()).toBe(2);
    expect(fixture.usageFacts()).toHaveLength(1);
  }).pipe(Effect.provide(fixture.layer));
});

function claim(statement: string): ResearchSynthesis.MaterialClaim {
  return {
    evidence: [{ quote: "measured result improved", sourceId: "S1" }],
    statement,
  };
}

const reportWorkflowId = ResearchReport.WorkflowId.make("research:publication-recovery");
const reportContentId = ContentId.make(`document:workflow:${reportWorkflowId}`);
const reportNow = new Date("2026-08-27T12:00:00.000Z");

const collection: ResearchCollector.Collection = {
  manifest: ResearchCollector.SourceManifest.make({
    sources: retained.map(({ source }) => source),
    version: "research-source-manifest-v1",
    workflowId: reportWorkflowId,
  }),
  manifestDigest: ResearchReport.InputDigest.make("e".repeat(64)),
  manifestKey: "users/report/research-report/manifests/report.json",
  pages: [
    {
      _tag: "Page",
      contentDigest:
        retained[0]?.source.contentDigest ?? ResearchReport.InputDigest.make("d".repeat(64)),
      contentKey: retained[0]?.source.contentKey ?? "users/report/source.json",
      contentType: "text/html",
      fetchedAt: reportNow,
      finalUrl: retained[0]?.source.url ?? "https://example.com/result",
      title: retained[0]?.source.title ?? null,
    },
  ],
};

const publicationFixture = (options: {
  readonly accountFailures?: number;
  readonly successFailures?: number;
  readonly usageFailures?: number;
}) => {
  let accountFailures = options.accountFailures ?? 0;
  let successFailures = options.successFailures ?? 0;
  let usageFailures = options.usageFailures ?? 0;
  let current = reportRecord();
  let retainedArtifact: StoredArtifactMetadata | null = null;
  let renders = 0;
  let accounts = 0;
  let usageAttempts = 0;
  const usageFacts = new Set<string>();
  const bytes = new Uint8Array([1, 2, 3]);
  const renderCost = {
    _tag: "Incurred" as const,
    allowancePeriodId: current.allowancePeriodId,
    basis: "observed" as const,
    providerOperationId: "render-publication-recovery",
    usdMicros: 10n,
  };
  const artifacts: ResearchReportDocument.PortInterface["artifacts"] = {
    account: () =>
      Effect.gen(function* () {
        accounts += 1;
        if (accountFailures > 0) {
          accountFailures -= 1;
          return yield* new ArtifactStoreUnavailable({
            cause: "R2 unavailable",
            message: "R2 unavailable",
            operation: "account",
          });
        }
        if (retainedArtifact === null) {
          return yield* new ArtifactIntegrityFailure({
            contentId: reportContentId,
            message: "Pending retained Client Content is missing",
          });
        }
        retainedArtifact = { ...retainedArtifact, retention: "accounted" };
        return undefined;
      }),
    delete: () => Effect.sync(() => void (retainedArtifact = null)),
    inspect: () => Effect.sync(() => retainedArtifact),
    put: (artifact) => Effect.sync(() => void (retainedArtifact = artifact)),
    readBytes: (artifact) =>
      artifact.retention === "accounted"
        ? Effect.succeed(bytes)
        : Effect.fail(
            new ArtifactIntegrityFailure({
              contentId: artifact.artifact.content.contentId,
              message: "Pending Client Content is not readable",
            }),
          ),
  };
  const port = ResearchReportDocument.Port.of({
    artifacts,
    authorize: (report) => Effect.succeed({ authorization: reportAuthorization(), report }),
    claimPublication: (report, contentId) =>
      Effect.sync(() => {
        current = {
          ...report,
          artifactContentId: contentId,
          artifactStoredAt: reportNow,
          state: "artifact_stored",
        };
        return current;
      }),
    commitPublication: (report, contentId) =>
      Effect.sync(() => {
        current = {
          ...report,
          artifactContentId: contentId,
          publicationCommittedAt: reportNow,
          state: "publication_committed",
        };
        return current;
      }),
    completeSuccess: (report) =>
      Effect.gen(function* () {
        if (successFailures > 0) {
          successFailures -= 1;
          return yield* new ResearchReport.Unavailable({
            cause: "PostgreSQL unavailable",
            message: "PostgreSQL unavailable",
            operation: "completeSuccess",
          });
        }
        current = { ...report, state: "success", terminalAt: reportNow };
        return current;
      }),
    compute: {
      dispose: () => Effect.void,
      generate: () =>
        Effect.sync(() => {
          renders += 1;
          return {
            _tag: "Completed" as const,
            bytes,
            cost: renderCost,
            renderedPageCount: 4,
          };
        }),
      inspect: () => Effect.succeed(null),
    },
    maximumComputeUsdMicros: 100n,
    recordRenderCost: () => Effect.void,
    recordUsage: (report, artifact) =>
      Effect.gen(function* () {
        usageAttempts += 1;
        if (usageFailures > 0) {
          usageFailures -= 1;
          return yield* new ResearchReportDocument.Unavailable({
            cause: "Usage unavailable",
            message: "Usage unavailable",
            operation: "recordUsage",
            reason: "storageUnavailable",
          });
        }
        usageFacts.add(`${report.workflowId}:${artifact.content.sha256}`);
        return undefined;
      }),
    validator: {
      validate: (contentId, format, generated, pageCount) =>
        DocumentArtifact.make(contentId, format, generated.byteLength, pageCount, "f".repeat(64)),
    },
  });
  const collector = ResearchCollector.Service.of({
    collect: () => Effect.succeed(collection),
    discard: () => Effect.void,
    read: () => Effect.succeed(retained),
    resumeCommitted: () => Effect.succeed(collection),
  });
  const synthesisService = ResearchSynthesis.Service.of({
    synthesize: () =>
      Effect.succeed({
        companyCost: ResearchSynthesis.CompanyCost.make({
          basis: "observed",
          inputTokens: 10n,
          outputTokens: 10n,
          providerOperationId: "synthesis-publication-recovery",
          usdMicros: 20n,
        }),
        operationId: ResearchSynthesis.OperationId.make("synthesis-publication-recovery"),
        result: synthesis,
        resultDigest: ResearchReport.InputDigest.make("a".repeat(64)),
        resultKey: "users/report/research-report/syntheses/report.json",
      }),
  });
  return {
    accountAttempts: () => accounts,
    computeCalls: () => renders,
    layer: ResearchReportDocument.layerWithoutDependencies.pipe(
      Layer.provide(Layer.succeed(ResearchReportDocument.Port, port)),
      Layer.provide(Layer.succeed(ResearchCollector.Service, collector)),
      Layer.provide(Layer.succeed(ResearchSynthesis.Service, synthesisService)),
    ),
    port,
    report: () => current,
    stored: () => retainedArtifact,
    usageAttempts: () => usageAttempts,
    usageFacts: () => [...usageFacts],
  };
};

const reportRecord = (): ResearchReport.Record => ({
  acceptedAt: reportNow,
  actionId: ActionId.make("publication-recovery-action"),
  admittedAt: reportNow,
  agentId: AgentId.make("publication-recovery-agent"),
  allowancePeriodId: AllowancePeriodId.make("publication-recovery-period"),
  approval: null,
  artifactContentId: null,
  artifactStoredAt: null,
  cancelRequestedAt: null,
  capabilityCatalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
  cloudflareInstanceId: ResearchReport.CloudflareInstanceId.make("publication-recovery-instance"),
  deadlineAt: new Date("2026-08-27T13:00:00.000Z"),
  inputDigest: ResearchReport.InputDigest.make("b".repeat(64)),
  manifestVersion: "research-source-manifest-v1",
  modelAccessPolicyVersion: ModelAccessPolicyVersion.make("launch-v1"),
  modelRoute: ManagedModelRoute.make("@cf/deepseek-ai/deepseek-v4-flash-0731"),
  originatingAuthority: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("publication-recovery-auth"),
  },
  planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
  publicationCommittedAt: null,
  request: ResearchReport.Request.make({
    consequences: [],
    format: "pdf",
    queries: ["publication recovery"],
    topic: "Publication recovery",
  }),
  resourcePriceVersion: ResourcePriceVersion.make("resource-prices-2026-08-22"),
  routeId: ConversationRouteId.make("publication-recovery-route"),
  safeFailureCode: null,
  sessionId: SessionId.make("publication-recovery-session"),
  sourceManifestDigest: collection.manifestDigest,
  sourceManifestKey: collection.manifestKey,
  startedAt: reportNow,
  state: "sources_committed",
  terminalAt: null,
  userId: UserId.make("publication-recovery-user"),
  workflowId: reportWorkflowId,
});

const reportAuthorization = (): AuthorizationContext => ({
  allowance: {
    _tag: "Metered",
    allowancePeriodId: AllowancePeriodId.make("publication-recovery-period"),
    endsAt: new Date("2026-09-27T12:00:00.000Z"),
    plan: "adventurer",
    planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    startsAt: reportNow,
    usage: [],
  },
  approval: null,
  authority: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("publication-recovery-auth"),
    expiresAt: new Date("2026-09-27T12:00:00.000Z"),
    userId: UserId.make("publication-recovery-user"),
  },
  deletionAccess: { _tag: "DeletionAccessAvailable" },
  gmailConnection: null,
  integrationConnections: [],
  liveFacts: emptyLiveResourceFacts,
  now: reportNow,
  originatingAuthority: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("publication-recovery-auth"),
  },
  requestVendorUsdMicros: 0n,
  resourceOwnerUserId: UserId.make("publication-recovery-user"),
  subscription: { plan: "adventurer", planPolicyVersion: PlanPolicyVersion.make("launch-v1") },
  user: { _tag: "ActiveUser", userId: UserId.make("publication-recovery-user") },
});
