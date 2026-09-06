import { Effect, Result, Schema } from "effect";

import { ManifestVersion, ResourcePriceVersion } from "../domain";
import type { AllowanceItem, AllowanceSource } from "../domain/allowance";
import type { DocumentArtifact } from "../domain/document-artifact";
import { retainedCatalog } from "../domain/plan-policy";
import { managedModelRoutinePrice, rate } from "../domain/usage";
import type { UsageEvent } from "../domain/usage-event";
import type { CostEvidence } from "./document-generation";
import type { ResearchCollector } from "./research-collector";
import type { ResearchReport } from "./research-report";
import type { ResearchSynthesis } from "./research-synthesis";

/* oxlint-disable eslint/no-underscore-dangle -- Accounting outcomes use the standard tagged discriminator. */

export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "ResearchReportAccountingUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals(["renderCost", "synthesisCost", "usefulReport", "workflowStart"]),
  },
) {}

export class PersistenceUnavailable extends Schema.TaggedError<PersistenceUnavailable>()(
  "ResearchReportAccountingPersistenceUnavailable",
  { cause: Schema.Defect() },
) {}

export interface Port {
  readonly recordLegacy: (
    allowancePeriodId: ResearchReport.Record["allowancePeriodId"],
    source: AllowanceSource,
    items: ReadonlyArray<AllowanceItem>,
  ) => Effect.Effect<void, PersistenceUnavailable>;
  readonly recordUsageEvent: (event: UsageEvent) => Effect.Effect<void, PersistenceUnavailable>;
}

export interface Interface {
  readonly recordRenderCost: (
    report: ResearchReport.Record,
    cost: CostEvidence,
  ) => Effect.Effect<void, Unavailable>;
  readonly recordSynthesisCost: (
    report: ResearchReport.Record,
    cost: ResearchSynthesis.CompanyCost,
  ) => Effect.Effect<void, Unavailable>;
  readonly recordUsefulReport: (
    report: ResearchReport.Record,
    artifact: DocumentArtifact.ArtifactRef,
    synthesisCost: ResearchSynthesis.CompanyCost,
    renderCost: CostEvidence,
    searches?: ReadonlyArray<ResearchCollector.CompletedSearch>,
  ) => Effect.Effect<void, Unavailable>;
  readonly recordWorkflowStart: (report: ResearchReport.Record) => Effect.Effect<void, Unavailable>;
}

export type UsefulReportAccounting =
  | {
      readonly _tag: "Launch";
      readonly facts: ReadonlyArray<{
        readonly items: ReadonlyArray<AllowanceItem>;
        readonly source: AllowanceSource;
      }>;
    }
  | { readonly _tag: "Shared"; readonly event: UsageEvent };

/** Interpret retained launch and inactive shared-Usage accounting without mixing their ledgers. */
export const make = (port: Port): Interface => ({
  // Provider-owned durable evidence retains Company Cost. User allowance changes only after useful success.
  recordRenderCost: () => Effect.void,
  recordSynthesisCost: () => Effect.void,
  recordUsefulReport: (report, artifact, synthesisCost, renderCost, searches) =>
    usefulReportAccountingFor(report, artifact, synthesisCost, renderCost, searches).pipe(
      Effect.flatMap((accounting) =>
        accounting._tag === "Shared"
          ? port.recordUsageEvent(accounting.event)
          : Effect.forEach(
              accounting.facts,
              ({ items, source }) => port.recordLegacy(report.allowancePeriodId, source, items),
              { discard: true },
            ),
      ),
      Effect.mapError((cause) =>
        unavailable(
          "usefulReport",
          "The useful Research Report accounting could not be retained",
          cause,
        ),
      ),
    ),
  recordWorkflowStart: (report) =>
    report.planPolicyVersion !== "launch-v1"
      ? Effect.void
      : recordLegacy(
          port,
          report,
          { sourceId: report.workflowId, sourceType: "workflow" },
          [{ allowanceKind: "workflowStarts", basis: "known_at_start", quantity: 1n }],
          "workflowStart",
        ),
});

/** Build the exact immutable User accounting facts before the PostgreSQL commit boundary. */
export const usefulReportAccountingFor = (
  report: ResearchReport.Record,
  artifact: DocumentArtifact.ArtifactRef,
  synthesisCost: ResearchSynthesis.CompanyCost,
  renderCost: CostEvidence,
  searches: ReadonlyArray<ResearchCollector.CompletedSearch> = [],
): Effect.Effect<UsefulReportAccounting, Unavailable> => {
  const searchCosts = searches.flatMap((search) => {
    const cost = search.managedSearch.ratedCostUsdMicros;
    const admission = search.searchAdmission.admission;
    if (
      search.workflowId !== report.workflowId ||
      search.operationId !== search.managedSearch.attemptId ||
      admission.allowancePeriodId !== report.allowancePeriodId ||
      admission.planPolicyVersion !== report.planPolicyVersion ||
      admission.capabilityCatalogVersion !== report.capabilityCatalogVersion ||
      admission.originatingAuthority._tag !== "DurableTrigger" ||
      admission.originatingAuthority.triggerId !== report.workflowId ||
      cost === null ||
      cost <= 0 ||
      search.managedSearch.successfulSearches !== 1
    )
      return [];
    return [
      {
        operationId: search.operationId,
        ratedCostUsdMicros: BigInt(cost),
        resourcePriceVersion: ResourcePriceVersion.make(search.managedSearch.resourcePriceVersion),
      },
    ];
  });
  if (
    searchCosts.length !== searches.length ||
    new Set(searchCosts.map((search) => search.operationId)).size !== searchCosts.length
  ) {
    return Effect.fail(
      unavailable(
        "usefulReport",
        "Completed search cost or its report ownership cannot be established",
      ),
    );
  }
  if (report.planPolicyVersion === "launch-v1") {
    return Effect.succeed({
      _tag: "Launch" as const,
      facts: [
        ...searchCosts.map((search) => ({
          items: [
            {
              allowanceKind: "vendorUsdMicros" as const,
              basis: "observed" as const,
              quantity: search.ratedCostUsdMicros,
            },
          ],
          source: { sourceId: search.operationId, sourceType: "researchSearchOperation" },
        })),
        ...(synthesisCost.usdMicros > 0n
          ? [
              {
                items: [
                  {
                    allowanceKind: "vendorUsdMicros" as const,
                    basis: synthesisCost.basis,
                    quantity: synthesisCost.usdMicros,
                  },
                ],
                source: {
                  sourceId: synthesisCost.providerOperationId,
                  sourceType: "researchModelOperation" as const,
                },
              },
            ]
          : []),
        ...(renderCost._tag === "Incurred" && renderCost.usdMicros > 0n
          ? [
              {
                items: [
                  {
                    allowanceKind: "vendorUsdMicros" as const,
                    basis: renderCost.basis,
                    quantity: renderCost.usdMicros,
                  },
                ],
                source: {
                  sourceId: renderCost.providerOperationId,
                  sourceType: "documentProviderOperation" as const,
                },
              },
            ]
          : []),
        {
          items: [{ allowanceKind: "researchReports", basis: "observed", quantity: 1n }],
          source: { sourceId: report.workflowId, sourceType: "workflow" },
        },
      ],
    });
  }
  if (report.artifactStoredAt === null) {
    return Effect.fail(
      unavailable(
        "usefulReport",
        "Useful Usage requires a committed readable artifact",
        report.state,
      ),
    );
  }
  const nonModel =
    renderCost._tag === "Incurred" && renderCost.usdMicros > 0n
      ? [
          {
            activity: "filesAndArtifacts" as const,
            ratedCostUsdMicros: renderCost.usdMicros,
            resourcePriceVersion: report.resourcePriceVersion,
          },
        ]
      : [];
  const rated = rate(
    [
      {
        activity: "webAndResearch",
        cachedInputTokens: 0n,
        inputTokens: synthesisCost.inputTokens,
        outputTokens: synthesisCost.outputTokens,
        price: managedModelRoutinePrice,
      },
    ],
    [
      ...nonModel,
      ...searchCosts.map((search) => ({
        activity: "webAndResearch" as const,
        ratedCostUsdMicros: search.ratedCostUsdMicros,
        resourcePriceVersion: search.resourcePriceVersion,
      })),
    ],
    retainedCatalog,
    report.planPolicyVersion,
  );
  if (Result.isFailure(rated)) {
    return Effect.fail(
      unavailable(
        "usefulReport",
        "Pinned useful Research Report evidence cannot be rated",
        rated.failure,
      ),
    );
  }
  const event: UsageEvent = {
    allowancePeriodId: report.allowancePeriodId,
    capabilityCatalogVersion: report.capabilityCatalogVersion,
    evidenceReferences: [
      ...searchCosts.map((search) => ({
        kind: "operationEvidence" as const,
        reference: search.operationId,
      })),
      { kind: "operationEvidence", reference: synthesisCost.providerOperationId },
      { kind: "operationEvidence", reference: artifact.content.contentId },
      ...(renderCost._tag === "Incurred"
        ? [{ kind: "companyCost" as const, reference: renderCost.providerOperationId }]
        : []),
    ],
    manifestVersion:
      report.manifestVersion === null ? null : ManifestVersion.make(report.manifestVersion),
    modelAccessPolicyVersion: report.modelAccessPolicyVersion,
    occurredAt: report.artifactStoredAt,
    outcome: { _tag: "Completed", charge: rated.success },
    rootOperationId: report.workflowId,
    source: { sourceId: report.workflowId, sourceType: "workflow" },
    usagePolicyVersion: report.planPolicyVersion,
  };
  return Effect.succeed({ _tag: "Shared" as const, event });
};

const recordLegacy = (
  port: Port,
  report: ResearchReport.Record,
  source: AllowanceSource,
  items: ReadonlyArray<AllowanceItem>,
  operation: Unavailable["operation"],
) =>
  port
    .recordLegacy(report.allowancePeriodId, source, items)
    .pipe(
      Effect.mapError((cause) =>
        unavailable(
          operation,
          "Retained launch Research Report facts could not be recorded",
          cause,
        ),
      ),
    );

const unavailable = (
  operation: Unavailable["operation"],
  message: string,
  cause: unknown = operation,
) => new Unavailable({ cause, message, operation });

export * as ResearchReportAccounting from "./research-report-accounting";
