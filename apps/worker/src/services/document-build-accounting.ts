import { Effect, Result, Schema } from "effect";

import { ManifestVersion, type AllowancePeriodId } from "../domain";
import type { AllowanceItem, AllowanceSource } from "../domain/allowance";
import type { DocumentArtifact } from "../domain/document-artifact";
import { retainedCatalog } from "../domain/plan-policy";
import { rate } from "../domain/usage";
import type { UsageEvent } from "../domain/usage-event";
import type { DocumentBuild } from "./document-build";
import type { CostEvidence } from "./document-generation";

/* oxlint-disable eslint/no-underscore-dangle -- Accounting outcomes use the standard Effect discriminator. */

export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "DocumentBuildAccountingUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals(["usefulDocument", "workflowStart"]),
  },
) {}

export class PersistenceUnavailable extends Schema.TaggedError<PersistenceUnavailable>()(
  "DocumentBuildAccountingPersistenceUnavailable",
  { cause: Schema.Defect() },
) {}

export interface Port {
  readonly recordLegacy: (
    allowancePeriodId: AllowancePeriodId,
    source: AllowanceSource,
    items: ReadonlyArray<AllowanceItem>,
  ) => Effect.Effect<void, PersistenceUnavailable>;
  readonly recordUsageEvent: (event: UsageEvent) => Effect.Effect<void, PersistenceUnavailable>;
}

export interface Interface {
  readonly recordGeneratedDocument: (
    build: DocumentBuild.Record,
    artifact: DocumentArtifact.ArtifactRef,
    renderCost: CostEvidence,
  ) => Effect.Effect<void, Unavailable>;
  /** Provider attempt evidence remains Company Cost until useful publication wins. */
  readonly recordProviderCost: (
    build: DocumentBuild.Record,
    cost: CostEvidence,
  ) => Effect.Effect<void, Unavailable>;
  readonly recordWorkflowStart: (build: DocumentBuild.Record) => Effect.Effect<void, Unavailable>;
}

export type UsefulDocumentAccounting =
  | {
      readonly _tag: "Launch";
      readonly facts: ReadonlyArray<{
        readonly items: ReadonlyArray<AllowanceItem>;
        readonly source: AllowanceSource;
      }>;
    }
  | { readonly _tag: "Shared"; readonly event: UsageEvent };

export const make = (port: Port): Interface => ({
  recordGeneratedDocument: (build, artifact, renderCost) =>
    usefulDocumentAccountingFor(build, artifact, renderCost).pipe(
      Effect.flatMap((accounting) =>
        accounting._tag === "Shared"
          ? port.recordUsageEvent(accounting.event)
          : Effect.forEach(
              accounting.facts,
              ({ items, source }) => port.recordLegacy(build.allowancePeriodId, source, items),
              { discard: true },
            ),
      ),
      Effect.mapError((cause) =>
        unavailable("usefulDocument", "Useful Document Build accounting is unavailable", cause),
      ),
    ),
  recordProviderCost: () => Effect.void,
  recordWorkflowStart: (build) =>
    build.planPolicyVersion !== "launch-v1"
      ? Effect.void
      : port
          .recordLegacy(
            build.allowancePeriodId,
            { sourceId: build.workflowId, sourceType: "documentBuild" },
            [{ allowanceKind: "workflowStarts", basis: "known_at_start", quantity: 1n }],
          )
          .pipe(
            Effect.mapError((cause) =>
              unavailable("workflowStart", "Document Build start accounting is unavailable", cause),
            ),
          ),
});

/** Build final useful accounting without charging failed or canceled attempts. */
export const usefulDocumentAccountingFor = (
  build: DocumentBuild.Record,
  artifact: DocumentArtifact.ArtifactRef,
  renderCost: CostEvidence,
): Effect.Effect<UsefulDocumentAccounting, Unavailable> => {
  if (build.planPolicyVersion === "launch-v1") {
    return Effect.succeed({
      _tag: "Launch" as const,
      facts: [
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
                  sourceType: "documentProviderOperation",
                },
              },
            ]
          : []),
        {
          items: [{ allowanceKind: "generatedDocuments", basis: "observed", quantity: 1n }],
          source: { sourceId: build.workflowId, sourceType: "documentBuild" },
        },
      ],
    });
  }
  if (build.publicationCommittedAt === null || renderCost._tag !== "Incurred") {
    return Effect.fail(
      unavailable(
        "usefulDocument",
        "Shared Usage requires committed publication and positive render evidence",
        build.state,
      ),
    );
  }
  const rated = rate(
    [],
    [
      {
        activity: "filesAndArtifacts",
        ratedCostUsdMicros: renderCost.usdMicros,
        resourcePriceVersion: build.resourcePriceVersion,
      },
    ],
    retainedCatalog,
    build.planPolicyVersion,
  );
  if (Result.isFailure(rated)) {
    return Effect.fail(
      unavailable(
        "usefulDocument",
        "Pinned Document Build evidence cannot be rated",
        rated.failure,
      ),
    );
  }
  return Effect.succeed({
    _tag: "Shared" as const,
    event: {
      allowancePeriodId: build.allowancePeriodId,
      capabilityCatalogVersion: build.capabilityCatalogVersion,
      evidenceReferences: [
        { kind: "operationEvidence", reference: artifact.content.contentId },
        { kind: "companyCost", reference: renderCost.providerOperationId },
      ],
      manifestVersion:
        build.manifestVersion === null ? null : ManifestVersion.make(build.manifestVersion),
      modelAccessPolicyVersion: build.modelAccessPolicyVersion,
      occurredAt: build.publicationCommittedAt,
      outcome: { _tag: "Completed", charge: rated.success },
      rootOperationId: build.workflowId,
      source: { sourceId: build.workflowId, sourceType: "documentBuild" },
      usagePolicyVersion: build.planPolicyVersion,
    },
  });
};

const unavailable = (
  operation: Unavailable["operation"],
  message: string,
  cause: unknown = operation,
) => new Unavailable({ cause, message, operation });

export * as DocumentBuildAccounting from "./document-build-accounting";
