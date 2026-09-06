import { FileNormalizationProvenance } from "../services/files";
import type { Interface as Files } from "../services/files";
import { fill } from "../integrations/pdf/pdf-form";
import { DocumentArtifact } from "../domain/document-artifact";
import { DateTime, Effect, Predicate, Schema } from "effect";

import type { Database } from "../db";
import { BillingDb } from "../db/billing";
import { currentCapabilityCatalog } from "../domain/capability-catalog";
import { retainedCatalog } from "../domain/plan-policy";
import { DocumentArtifacts } from "../integrations/cloudflare/document-artifacts";
import { DocumentArtifactValidation } from "../integrations/cloudflare/document-artifact-validation";
import { DocumentCompute } from "../integrations/cloudflare/document-compute";
import { ArtifactStore } from "../integrations/cloudflare/artifact-store";
import { Allowances } from "../services/allowances";
import { Authorization } from "../services/authorization";
import { DocumentGeneration } from "../services/document-generation";
import type { AuthorizationContext } from "../services/authorization";

/** Cloudflare bindings required by the production document capability. */
export interface Bindings {
  readonly ARTIFACTS: R2Bucket;
  readonly DOCUMENT_SANDBOX: Env["DOCUMENT_SANDBOX"];
}

/** Conservative cost evidence for one bounded Sandbox execution attempt. */
export const conservativeDocumentSandboxUsdMicros = 50_000n;

/** Compose the production document capability at a ToolCall or Workflow boundary. */
export const make = (
  bindings: Bindings,
  database: Database,
  currentAuthorization: (
    admitted: AuthorizationContext,
  ) => Effect.Effect<AuthorizationContext, DocumentGeneration.DocumentAuthorizationUnavailable>,
  readTemplate?: (
    input: Parameters<Files["read"]>[0],
  ) => Effect.Effect<
    Effect.Success<ReturnType<Files["read"]>>,
    DocumentGeneration.DocumentAuthorizationUnavailable
  >,
): DocumentGeneration.Interface => {
  const visualArtifacts = ArtifactStore.make(bindings.ARTIFACTS);
  return DocumentGeneration.make({
    pdfForms: {
      prepare: (contentId, source, authorization, actionId) =>
        Effect.gen(function* () {
          if (readTemplate === undefined)
            return yield* DocumentArtifact.invalid(
              contentId,
              "invalidDocument",
              "Owned PDF template reading is unavailable",
            );
          const template = yield* readTemplate({
            fileId: source.templateFileId,
            context: authorization,
            actionId,
          }).pipe(
            Effect.mapError(
              () =>
                new DocumentArtifact.InvalidGeneratedArtifact({
                  contentId,
                  reason: "invalidDocument",
                  message: "The owned PDF template is unavailable",
                }),
            ),
          );
          if (
            !Predicate.isTagged(template, "FileRead") ||
            template.file.state !== "ready" ||
            template.file.mediaType !== "application/pdf" ||
            template.file.sha256 !== source.templateDigest
          )
            return yield* DocumentArtifact.invalid(
              contentId,
              "invalidDocument",
              "The owned ready PDF template does not match the requested digest",
            );
          const provenance = yield* Schema.decodeEffect(
            Schema.fromJsonString(FileNormalizationProvenance),
          )(template.file.provenanceJson).pipe(
            Effect.mapError(
              () =>
                new DocumentArtifact.InvalidGeneratedArtifact({
                  contentId,
                  reason: "invalidDocument",
                  message: "PDF provenance is invalid",
                }),
            ),
          );
          if (
            provenance.sourceSha256 !== source.templateDigest ||
            provenance.mediaType !== "application/pdf"
          )
            return yield* DocumentArtifact.invalid(
              contentId,
              "invalidDocument",
              "PDF provenance digest differs",
            );
          if (provenance.pdfForm !== undefined) return { templateBytes: template.bytes };
          return yield* fill(contentId, template.bytes, source);
        }),
    },
    allowances: Allowances.make({
      billing: BillingDb.make(database),
      catalog: retainedCatalog,
      now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
    }),
    artifacts: DocumentArtifacts.make(bindings.ARTIFACTS),
    artifactValidator: DocumentArtifactValidation,
    authorization: Authorization.make(retainedCatalog),
    compute: DocumentCompute.make(
      bindings.DOCUMENT_SANDBOX,
      bindings.ARTIFACTS,
      conservativeDocumentSandboxUsdMicros,
    ),
    currentAuthorization,
    maximumComputeInputBytes: Number(currentCapabilityCatalog.operationLimits.computeInputBytes),
    visuals: {
      read: (contentId, userId) =>
        Effect.gen(function* () {
          const metadata = yield* visualArtifacts.inspect(contentId);
          if (
            metadata === null ||
            metadata.userId !== userId ||
            metadata.retention !== "accounted" ||
            (!Predicate.isTagged(metadata.artifact.artifactRole, "GeneratedImageV1") &&
              !Predicate.isTagged(metadata.artifact.artifactRole, "GeneratedDiagramV1"))
          ) {
            return yield* new DocumentGeneration.DocumentSupportingVisualUnavailable({
              contentId,
              message: "The referenced owned verified visual is unavailable",
            });
          }
          return yield* visualArtifacts.readBytes(metadata);
        }).pipe(
          Effect.mapError(
            () =>
              new DocumentGeneration.DocumentSupportingVisualUnavailable({
                contentId,
                message: "The referenced owned verified visual could not be read",
              }),
          ),
        ),
    },
  });
};

/** Reconcile one bounded batch of durable incurred-cost evidence into Allowances. */
export const reconcileCosts = (bindings: Pick<Bindings, "ARTIFACTS">, database: Database) => {
  const allowances = Allowances.make({
    billing: BillingDb.make(database),
    catalog: retainedCatalog,
    now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
  });
  return DocumentCompute.readReconciliationBatch(bindings.ARTIFACTS).pipe(
    Effect.flatMap((batch) =>
      Effect.forEach(
        batch.costs,
        (cost) =>
          allowances.record(
            cost.allowancePeriodId,
            {
              sourceId: cost.providerOperationId,
              sourceType: "documentProviderOperation",
            },
            [
              {
                allowanceKind: "vendorUsdMicros",
                basis: cost.basis,
                quantity: cost.usdMicros,
              },
            ],
          ),
        { concurrency: 5, discard: true },
      ).pipe(
        Effect.andThen(DocumentCompute.advanceReconciliation(bindings.ARTIFACTS, batch.checkpoint)),
      ),
    ),
  );
};

export * as DocumentGenerationComposition from "./document-generation";
