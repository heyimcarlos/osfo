import { Effect, Result, Schema } from "effect";

import { ManifestVersion } from "../domain";
import type { AllowanceItem, AllowanceSource } from "../domain/allowance";
import type { DocumentArtifact } from "../domain/document-artifact";
import { retainedCatalog } from "../domain/plan-policy";
import { managedModelRoutinePrice, rate } from "../domain/usage";
import type { UsageEvent } from "../domain/usage-event";
import type { CostEvidence } from "./document-generation";
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
  ) => Effect.Effect<void, Unavailable>;
  readonly recordWorkflowStart: (report: ResearchReport.Record) => Effect.Effect<void, Unavailable>;
}

/** Interpret retained launch and inactive shared-Usage accounting without mixing their ledgers. */
export const make = (port: Port): Interface => ({
  // Provider-owned durable evidence retains Company Cost. User allowance changes only after useful success.
  recordRenderCost: () => Effect.void,
  recordSynthesisCost: () => Effect.void,
  recordUsefulReport: (report, artifact, synthesisCost, renderCost) => {
    if (report.planPolicyVersion === "launch-v1") {
      return Effect.gen(function* () {
        if (synthesisCost.usdMicros > 0n) {
          yield* recordLegacy(
            port,
            report,
            {
              sourceId: synthesisCost.providerOperationId,
              sourceType: "researchModelOperation",
            },
            [
              {
                allowanceKind: "vendorUsdMicros",
                basis: synthesisCost.basis,
                quantity: synthesisCost.usdMicros,
              },
            ],
            "synthesisCost",
          );
        }
        if (renderCost._tag === "Incurred" && renderCost.usdMicros > 0n) {
          yield* recordLegacy(
            port,
            report,
            {
              sourceId: renderCost.providerOperationId,
              sourceType: "documentProviderOperation",
            },
            [
              {
                allowanceKind: "vendorUsdMicros",
                basis: renderCost.basis,
                quantity: renderCost.usdMicros,
              },
            ],
            "renderCost",
          );
        }
        yield* recordLegacy(
          port,
          report,
          { sourceId: report.workflowId, sourceType: "workflow" },
          [{ allowanceKind: "researchReports", basis: "observed", quantity: 1n }],
          "usefulReport",
        );
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
      nonModel,
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
    return port
      .recordUsageEvent(event)
      .pipe(
        Effect.mapError((cause) =>
          unavailable(
            "usefulReport",
            "The useful Research Report Usage Event could not be retained",
            cause,
          ),
        ),
      );
  },
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
