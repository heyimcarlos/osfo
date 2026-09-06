/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effects returned to it.effect. */
/* oxlint-disable effecttsgo/global-date -- Fixed dates are immutable accounting evidence. */
/* oxlint-disable eslint/no-underscore-dangle -- Assertions inspect standard tagged outcomes. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AgentId,
  AllowancePeriodId,
  ConversationRouteId,
  ModelAccessPolicyVersion,
  PlanPolicyVersion,
  SessionId,
  UserId,
} from "../domain";
import { ActionId } from "../domain/action-execution";
import { AuthSessionId } from "../domain/auth-session";
import { currentCapabilityCatalog } from "../domain/capability-catalog";
import { ContentId } from "../domain/client-content";
import { DocumentArtifact } from "../domain/document-artifact";
import {
  launchModelAccessPolicy,
  sharedUsageModelAccessPolicy,
} from "../domain/model-access-policy";
import { currentResourcePriceVersion } from "../domain/usage";
import type { UsageEvent } from "../domain/usage-event";
import { initialManagedSearchEvidence } from "../domain/web-search-evidence";
import { ResearchCollector } from "./research-collector";
import { ResearchReport } from "./research-report";
import { ResearchReportAccounting } from "./research-report-accounting";
import { ResearchSynthesis } from "./research-synthesis";

it.effect(
  "replays launch facts against the pinned original period and conflicts on changed cost",
  () => {
    const fixture = makeFixture();
    const accounting = ResearchReportAccounting.make(fixture.port);
    const report = makeReport("launch-v1");
    return Effect.gen(function* () {
      const artifact = yield* makeArtifact();
      const synthesisCost = cost(20_000n);
      const renderCost = render(10_000n);
      yield* accounting.recordWorkflowStart(report);
      yield* accounting.recordWorkflowStart(report);
      yield* accounting.recordSynthesisCost(report, synthesisCost);
      yield* accounting.recordSynthesisCost(report, synthesisCost);
      yield* accounting.recordRenderCost(report, renderCost);
      yield* accounting.recordUsefulReport(report, artifact, synthesisCost, renderCost);
      yield* accounting.recordUsefulReport(report, artifact, synthesisCost, renderCost);

      expect(fixture.legacyFacts).toHaveLength(4);
      expect(
        fixture.legacyFacts.every(
          ({ allowancePeriodId }) => allowancePeriodId === report.allowancePeriodId,
        ),
      ).toBe(true);
      expect(fixture.legacyFacts.map(({ allowanceKind }) => allowanceKind)).toEqual([
        "workflowStarts",
        "vendorUsdMicros",
        "vendorUsdMicros",
        "researchReports",
      ]);
      expect(fixture.usageEvents).toHaveLength(0);

      const conflict = yield* accounting
        .recordUsefulReport(report, artifact, cost(20_001n), renderCost)
        .pipe(Effect.result);
      expect(conflict._tag).toBe("Failure");
    });
  },
);

it.effect("keeps shared Usage as one final useful event and never writes launch counters", () => {
  const fixture = makeFixture();
  const accounting = ResearchReportAccounting.make(fixture.port);
  const report = makeReport("shared-usage-v1");
  return Effect.gen(function* () {
    const artifact = yield* makeArtifact();
    const synthesisCost = cost(20_000n);
    const renderCost = render(10_000n);
    yield* accounting.recordWorkflowStart(report);
    yield* accounting.recordSynthesisCost(report, synthesisCost);
    yield* accounting.recordRenderCost(report, renderCost);
    yield* accounting.recordUsefulReport(report, artifact, synthesisCost, renderCost);
    yield* accounting.recordUsefulReport(report, artifact, synthesisCost, renderCost);

    expect(fixture.legacyFacts).toHaveLength(0);
    expect(fixture.usageEvents).toHaveLength(1);
    expect(fixture.usageEvents[0]).toMatchObject({
      allowancePeriodId: report.allowancePeriodId,
      source: { sourceId: report.workflowId, sourceType: "workflow" },
      usagePolicyVersion: "shared-usage-v1",
    });

    const conflict = yield* accounting
      .recordUsefulReport(
        report,
        artifact,
        ResearchSynthesis.CompanyCost.make({ ...cost(20_000n), inputTokens: 100_000n }),
        renderCost,
      )
      .pipe(Effect.result);
    expect(conflict._tag).toBe("Failure");
  });
});

it.effect(
  "retains failed and canceled provider attempts as Company Cost without User usage",
  () => {
    const fixture = makeFixture();
    const accounting = ResearchReportAccounting.make(fixture.port);
    const attempted = [
      {
        ...makeReport("launch-v1"),
        safeFailureCode: "invalid-synthesis-evidence",
        state: "failure" as const,
      },
      {
        ...makeReport("launch-v1"),
        safeFailureCode: "authority-ended",
        state: "canceled" as const,
      },
    ];

    return Effect.gen(function* () {
      for (const report of attempted) {
        yield* accounting.recordSynthesisCost(report, cost(20_000n));
        yield* accounting.recordRenderCost(report, render(10_000n));
      }

      expect(fixture.legacyFacts).toEqual([]);
      expect(fixture.usageEvents).toEqual([]);
    });
  },
);

it.effect("settles completed search once through the report's existing accounting owner", () =>
  Effect.gen(function* () {
    const artifact = yield* makeArtifact();
    for (const policy of ["launch-v1", "shared-usage-v1"] as const) {
      const report = makeReport(policy);
      const search = completedSearch(report);
      const fixture = makeFixture();
      const accounting = ResearchReportAccounting.make(fixture.port);
      yield* accounting.recordUsefulReport(report, artifact, cost(20_000n), render(10_000n), [
        search,
      ]);
      yield* accounting.recordUsefulReport(report, artifact, cost(20_000n), render(10_000n), [
        search,
      ]);
      if (policy === "launch-v1") {
        expect(fixture.legacyFacts).toHaveLength(4);
        expect(fixture.usageEvents).toHaveLength(0);
      } else {
        expect(fixture.usageEvents).toHaveLength(1);
        const baseline = yield* ResearchReportAccounting.usefulReportAccountingFor(
          report,
          artifact,
          cost(20_000n),
          render(10_000n),
        );
        const event = fixture.usageEvents[0];
        expect(baseline._tag).toBe("Shared");
        if (
          baseline._tag === "Shared" &&
          baseline.event.outcome._tag === "Completed" &&
          event?.outcome._tag === "Completed"
        ) {
          expect(
            event.outcome.charge.ratedCostUsdMicros -
              baseline.event.outcome.charge.ratedCostUsdMicros,
          ).toBe(13_562n);
          expect(event.evidenceReferences).toContainEqual({
            kind: "operationEvidence",
            reference: search.operationId,
          });
        }
      }
    }
  }),
);

it.effect(
  "rejects foreign, repeated or unknown-cost search evidence before report settlement",
  () =>
    Effect.gen(function* () {
      const report = makeReport("shared-usage-v1");
      const artifact = yield* makeArtifact();
      const search = completedSearch(report);
      const foreign = { ...search, workflowId: ResearchReport.WorkflowId.make("other-report") };
      const unknown = {
        ...search,
        managedSearch: { ...search.managedSearch, ratedCostUsdMicros: null },
      };
      for (const searches of [[foreign], [unknown], [search, search]]) {
        const result = yield* Effect.result(
          ResearchReportAccounting.usefulReportAccountingFor(
            report,
            artifact,
            cost(20_000n),
            render(10_000n),
            searches,
          ),
        );
        expect(result._tag).toBe("Failure");
      }
    }),
);

const completedSearch = (report: ResearchReport.Record): ResearchCollector.CompletedSearch => {
  const operationId = ResearchCollector.OperationId.make(`${report.workflowId}:provider:0`);
  return {
    operationId,
    workflowId: report.workflowId,
    managedSearch: {
      ...initialManagedSearchEvidence(operationId),
      ratedCostUsdMicros: 13_562,
      successfulSearches: 1,
    },
    searchAdmission: {
      admittedVendorUsdMicros: 50_000n,
      admission: {
        allowancePeriodId: report.allowancePeriodId,
        authorizedAt: report.admittedAt.toISOString(),
        capabilityCatalogVersion: report.capabilityCatalogVersion,
        planPolicyVersion: report.planPolicyVersion,
        originatingAuthority: {
          _tag: "DurableTrigger",
          triggerId: report.workflowId,
          triggerType: "workflow",
        },
      },
    },
  };
};

const makeFixture = () => {
  const legacy = new Map<string, string>();
  const usage = new Map<string, string>();
  const legacyFacts = new Array<{
    readonly allowanceKind: string;
    readonly allowancePeriodId: AllowancePeriodId;
  }>();
  const usageEvents = new Array<UsageEvent>();
  const port: ResearchReportAccounting.Port = {
    recordLegacy: (allowancePeriodId, source, items) =>
      Effect.gen(function* () {
        for (const item of items) {
          const key = `${allowancePeriodId}:${source.sourceType}:${source.sourceId}:${item.allowanceKind}`;
          const facts = `${item.allowanceKind}:${item.basis}:${item.quantity}`;
          const existing = legacy.get(key);
          if (existing !== undefined && existing !== facts) {
            return yield* new ResearchReportAccounting.PersistenceUnavailable({
              cause: "conflict",
            });
          }
          if (existing === undefined) {
            legacy.set(key, facts);
            legacyFacts.push({ allowanceKind: item.allowanceKind, allowancePeriodId });
          }
        }
        return undefined;
      }),
    recordUsageEvent: (event) =>
      Effect.gen(function* () {
        const key = `${event.allowancePeriodId}:${event.source.sourceType}:${event.source.sourceId}`;
        const facts = usageFingerprint(event);
        const existing = usage.get(key);
        if (existing !== undefined && existing !== facts) {
          return yield* new ResearchReportAccounting.PersistenceUnavailable({
            cause: "conflict",
          });
        }
        if (existing === undefined) {
          usage.set(key, facts);
          usageEvents.push(event);
        }
        return undefined;
      }),
  };
  return { legacyFacts, port, usageEvents };
};

const makeReport = (policy: "launch-v1" | "shared-usage-v1"): ResearchReport.Record => {
  const workflowId = ResearchReport.WorkflowId.make(`accounting-${policy}`);
  return {
    acceptedAt: new Date("2026-08-27T12:00:00.000Z"),
    actionId: ActionId.make(`accounting-action-${policy}`),
    admittedAt: new Date("2026-08-27T12:00:00.000Z"),
    artifactContentId: `document:workflow:${workflowId}`,
    artifactStoredAt: new Date("2026-08-27T12:20:00.000Z"),
    publicationCommittedAt: new Date("2026-08-27T12:20:00.500Z"),
    safeFailureCode: null,
    agentId: AgentId.make("accounting-agent"),
    allowancePeriodId: AllowancePeriodId.make(`original-period-${policy}`),
    approval: null,
    cancelRequestedAt: null,
    capabilityCatalogVersion: currentCapabilityCatalog.version,
    cloudflareInstanceId: ResearchReport.CloudflareInstanceId.make(workflowId),
    deadlineAt: new Date("2026-08-27T13:00:00.000Z"),
    inputDigest: ResearchReport.InputDigest.make("a".repeat(64)),
    manifestVersion: policy === "launch-v1" ? null : "composio-manifest-v1",
    modelAccessPolicyVersion: ModelAccessPolicyVersion.make(policy),
    modelRoute:
      policy === "launch-v1"
        ? launchModelAccessPolicy.plans.free.route
        : sharedUsageModelAccessPolicy.plans.free.route,
    originatingAuthority: {
      _tag: "AuthSession",
      authSessionId: AuthSessionId.make("accounting-auth-session"),
    },
    planPolicyVersion: PlanPolicyVersion.make(policy),
    request: ResearchReport.Request.make({
      consequences: [],
      format: "pdf",
      queries: ["accounting query"],
      topic: "Accounting report",
    }),
    resourcePriceVersion: currentResourcePriceVersion,
    routeId: ConversationRouteId.make("accounting-route"),
    sessionId: SessionId.make("accounting-session"),
    sourceManifestKey: "users/accounting/manifest.json",
    sourceManifestDigest: ResearchReport.InputDigest.make("e".repeat(64)),
    state: "success",
    startedAt: new Date("2026-08-27T12:00:01.000Z"),
    terminalAt: new Date("2026-08-27T12:20:01.000Z"),
    userId: UserId.make("accounting-user"),
    workflowId,
  };
};

const makeArtifact = () =>
  DocumentArtifact.make(
    ContentId.make("document:workflow:accounting"),
    "pdf",
    100,
    1,
    "b".repeat(64),
  );

const cost = (usdMicros: bigint): ResearchSynthesis.CompanyCost =>
  ResearchSynthesis.CompanyCost.make({
    basis: "observed",
    inputTokens: 1_000n,
    outputTokens: 500n,
    providerOperationId: "research-synthesis-operation",
    usdMicros,
  });

const render = (usdMicros: bigint) => ({
  _tag: "Incurred" as const,
  allowancePeriodId: AllowancePeriodId.make("original-render-period"),
  basis: "observed" as const,
  providerOperationId: "document-render-operation",
  usdMicros,
});

const usageFingerprint = (event: UsageEvent) => {
  const charge =
    event.outcome._tag === "Completed" || event.outcome._tag === "UsefulPartial"
      ? {
          components: event.outcome.charge.components.map((component) => ({
            activity: component.activity,
            evidence:
              "evidence" in component
                ? {
                    cachedInputTokens: component.evidence.cachedInputTokens.toString(),
                    inputTokens: component.evidence.inputTokens.toString(),
                    outputTokens: component.evidence.outputTokens.toString(),
                    priceEntryId: component.evidence.priceEntryId,
                  }
                : null,
            ratedCostUsdMicros: component.ratedCostUsdMicros.toString(),
            resourcePriceVersion: component.resourcePriceVersion,
          })),
          planUsageMicros: event.outcome.charge.planUsageMicros.toString(),
          ratedCostUsdMicros: event.outcome.charge.ratedCostUsdMicros.toString(),
        }
      : null;
  return JSON.stringify({
    ...event,
    occurredAt: event.occurredAt.toISOString(),
    outcome: { _tag: event.outcome._tag, charge },
  });
};
