import { getSandbox } from "@cloudflare/sandbox";
import { DateTime, Effect, Predicate } from "effect";

import type { Database } from "../db";
import { BillingDb } from "../db/billing";
import { currentCapabilityCatalog } from "../domain/capability-catalog";
import { retainedCatalog } from "../domain/plan-policy";
import { ArtifactCompute } from "../integrations/cloudflare/artifact-compute";
import { ArtifactStore } from "../integrations/cloudflare/artifact-store";
import { ArtifactValidation } from "../integrations/cloudflare/artifact-validation";
import { Allowances } from "../services/allowances";
import { ArtifactGeneration } from "../services/artifact-generation";
import { Authorization } from "../services/authorization";
import type { AuthorizationContext } from "../services/authorization";

export interface Bindings {
  readonly AI: Ai;
  readonly ARTIFACTS: R2Bucket;
  readonly DOCUMENT_SANDBOX: Env["DOCUMENT_SANDBOX"];
}

/** Conservative Company Cost evidence for one bounded visual-artifact attempt. */
export const conservativeArtifactVendorUsdMicros = 50_000n;

/** Compose the production visual-artifact capability at a ToolCall or Workflow seam. */
export const make = (
  bindings: Bindings,
  database: Database,
  currentAuthorization: (
    admitted: AuthorizationContext,
  ) => Effect.Effect<AuthorizationContext, ArtifactGeneration.ArtifactAuthorizationUnavailable>,
): ArtifactGeneration.Interface =>
  ArtifactGeneration.make({
    allowances: Allowances.make({
      billing: BillingDb.make(database),
      catalog: retainedCatalog,
      now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
    }),
    artifacts: ArtifactStore.make(bindings.ARTIFACTS),
    authorization: Authorization.make(retainedCatalog),
    compute: ArtifactCompute.makeWithPorts(
      (contentId) =>
        ArtifactCompute.adaptSandbox(
          getSandbox(bindings.DOCUMENT_SANDBOX, contentId, {
            enableDefaultSession: false,
            keepAlive: false,
            normalizeId: true,
            sleepAfter: "2m",
            transport: "rpc",
          }),
        ),
      ArtifactCompute.makeAttemptStore(bindings.ARTIFACTS),
      ArtifactCompute.workersAiImageProvider(bindings.AI),
      conservativeArtifactVendorUsdMicros,
    ),
    currentAuthorization,
    executionLimits: (request) => {
      const limits =
        currentCapabilityCatalog.planResourceLimits[request.authorization.subscription.plan]
          .artifact;
      return {
        computeMilliseconds: limits.computeMilliseconds,
        maximumOutputBytes: Predicate.isTagged(request.intent, "Presentation")
          ? limits.generatedPresentationBytes
          : limits.generatedImageBytes,
        modelSteps: Predicate.isTagged(request.intent, "Image") ? 1n : 0n,
      };
    },
    maximumComputeInputBytes: currentCapabilityCatalog.operationLimits.computeInputBytes,
    validator: ArtifactValidation,
  });

/** Reconcile one bounded batch of durable visual-artifact cost evidence into Allowances. */
export const reconcileCosts = (bindings: Pick<Bindings, "ARTIFACTS">, database: Database) => {
  const allowances = Allowances.make({
    billing: BillingDb.make(database),
    catalog: retainedCatalog,
    now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
  });
  return ArtifactCompute.readReconciliationBatch(bindings.ARTIFACTS).pipe(
    Effect.flatMap((batch) =>
      Effect.forEach(
        batch.costs,
        (cost) =>
          allowances.record(
            cost.allowancePeriodId,
            { sourceId: cost.providerOperationId, sourceType: "artifactProviderOperation" },
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
        Effect.andThen(ArtifactCompute.advanceReconciliation(bindings.ARTIFACTS, batch.checkpoint)),
      ),
    ),
  );
};

export * as ArtifactGenerationComposition from "./artifact-generation";
