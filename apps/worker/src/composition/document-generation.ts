import { DateTime, Effect } from "effect";

import type { Database } from "../db";
import { BillingDb } from "../db/billing";
import { retainedCatalog } from "../domain/plan-policy";
import { DocumentArtifacts } from "../integrations/cloudflare/document-artifacts";
import { DocumentArtifactValidation } from "../integrations/cloudflare/document-artifact-validation";
import { DocumentCompute } from "../integrations/cloudflare/document-compute";
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
): DocumentGeneration.Interface =>
  DocumentGeneration.make({
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
  });

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
