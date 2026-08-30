/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Effect outcomes and Workflow/Hyperdrive Promise boundaries use these canonical forms. */
import { createDb } from "@osfo/db";
import { Effect } from "effect";
import postgres from "postgres";

import type { QualificationCohortArtifactAuthority } from "../qualification-cohort-artifact-authority";
import { inspectQualificationCohortArtifacts } from "../integrations/cloudflare/qualification-cohort-artifacts";
import { makeQualificationCohortScrubAuthority } from "../integrations/postgres/qualification-cohort-scrub";
import {
  makeQualificationCohortScrubDispatchAuthority,
  QualificationCohortScrubDispatchUnavailable,
  type QualificationCohortScrubDispatchClaim,
} from "../integrations/postgres/qualification-cohort-scrub-dispatch";
import {
  qualificationCohortScrubDispatchBatchLimit,
  type QualificationCohortScrubDispatchIdentity,
  qualificationCohortScrubDispatchPayload,
} from "../qualification/cohort-scrub-dispatch";
import {
  QualificationCohortScrubDispatchConflict,
  reconcileQualificationCohortScrubDispatch,
  type QualificationCohortScrubDispatchPorts,
  type QualificationCohortScrubDispatchRetryable,
} from "../services/qualification-cohort-scrub-dispatch";
import type { QualificationCohortScrubRootWorkflowPayload } from "../qualification/cohort-scrub-root";

export interface Bindings {
  readonly DB: Pick<Hyperdrive, "connectionString">;
  readonly QUALIFICATION_COHORT_ARTIFACT_AUTHORITY: DurableObjectNamespace<QualificationCohortArtifactAuthority>;
  readonly QUALIFICATION_COHORT_SCRUB_ROOT_WORKFLOW: Workflow<QualificationCohortScrubRootWorkflowPayload>;
}

const withDatabase = async <Value>(
  bindings: Bindings,
  evaluate: (database: ReturnType<typeof createDb>) => Promise<Value>,
): Promise<Value> => {
  const client = postgres(bindings.DB.connectionString, {
    fetch_types: false,
    max: 1,
    prepare: true,
  });
  try {
    return await evaluate(createDb(client));
  } finally {
    await client.end();
  }
};

const ports = (bindings: Bindings): QualificationCohortScrubDispatchPorts => ({
  completionAuthority: async (identity, rootChecksum) => {
    const pg = await withDatabase(bindings, (database) =>
      Effect.runPromise(
        makeQualificationCohortScrubAuthority(database).inspectScrubRootCompletion(identity),
      ),
    );
    if (pg._tag === "Missing") return "Missing";
    if (pg._tag === "Conflict" || pg.rootChecksum !== rootChecksum) return "Conflict";
    const artifacts = await Effect.runPromise(
      inspectQualificationCohortArtifacts(
        bindings.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY,
        identity.executionId,
      ),
    );
    return artifacts._tag === "Scrubbed" && artifacts.rootChecksum === rootChecksum
      ? "Ready"
      : artifacts._tag === "Missing"
        ? "Missing"
        : "Conflict";
  },
  create: async (identity) => {
    const instance = await bindings.QUALIFICATION_COHORT_SCRUB_ROOT_WORKFLOW.create({
      id: identity.rootInstanceId,
      params: qualificationCohortScrubDispatchPayload(identity),
    });
    return instance;
  },
  get: (instanceId) => bindings.QUALIFICATION_COHORT_SCRUB_ROOT_WORKFLOW.get(instanceId),
  markRestartApplied: (identity, claimToken, intentChecksum) =>
    withDatabase(bindings, (database) =>
      Effect.runPromise(
        makeQualificationCohortScrubDispatchAuthority(database).markRestartApplied(
          identity,
          claimToken,
          intentChecksum,
        ),
      ),
    ),
  observe: (identity, claimToken, status) =>
    withDatabase(bindings, (database) =>
      Effect.runPromise(
        makeQualificationCohortScrubDispatchAuthority(database).observe(
          identity,
          claimToken,
          status,
        ),
      ),
    ),
  reserveRestart: (identity, claimToken, statusChecksum) =>
    withDatabase(bindings, (database) =>
      Effect.runPromise(
        makeQualificationCohortScrubDispatchAuthority(database).reserveRestart(
          identity,
          claimToken,
          statusChecksum,
        ),
      ),
    ),
  retainConflict: (identity, claimToken, failureChecksum) =>
    withDatabase(bindings, (database) =>
      Effect.runPromise(
        makeQualificationCohortScrubDispatchAuthority(database).retainConflict(
          identity,
          claimToken,
          failureChecksum,
        ),
      ),
    ),
  settle: (identity, claimToken, rootChecksum) =>
    withDatabase(bindings, (database) =>
      Effect.runPromise(
        makeQualificationCohortScrubDispatchAuthority(database).settle(
          identity,
          claimToken,
          rootChecksum,
        ),
      ),
    ),
});

export const dispatchQualificationCohortScrubRoot = (
  bindings: Bindings,
  identity: QualificationCohortScrubDispatchIdentity,
) => {
  // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- PG lease claims require a host-CSPRNG token, not deterministic Effect test randomness.
  const claimToken = crypto.randomUUID();
  return Effect.tryPromise({
    try: () => claimExact(bindings, identity, claimToken),
    catch: (cause) =>
      new QualificationCohortScrubDispatchUnavailable({ cause, operation: "claimExact" }),
  }).pipe(Effect.flatMap((claim) => reconcileClaim(claim, bindings)));
};

export const reconcileQualificationCohortScrubDispatches = (bindings: Bindings) => {
  // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- One host-CSPRNG token atomically identifies this bounded scanner claim batch.
  const claimToken = crypto.randomUUID();
  return Effect.tryPromise({
    try: () => claimBatch(bindings, claimToken),
    catch: (cause) =>
      new QualificationCohortScrubDispatchUnavailable({ cause, operation: "claimBatch" }),
  }).pipe(
    Effect.flatMap((claims) =>
      Effect.forEach(
        claims,
        (claim) =>
          reconcileQualificationCohortScrubDispatch(claim, ports(bindings)).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Qualification cohort scrub dispatch remains pending").pipe(
                Effect.annotateLogs({ cause, executionId: claim.executionId }),
              ),
            ),
          ),
        { concurrency: 1, discard: true },
      ),
    ),
  );
};

const claimExact = (
  bindings: Bindings,
  identity: QualificationCohortScrubDispatchIdentity,
  claimToken: string,
) =>
  withDatabase(bindings, (database) =>
    Effect.runPromise(
      makeQualificationCohortScrubDispatchAuthority(database).claimExact(identity, claimToken),
    ),
  );

const claimBatch = (bindings: Bindings, claimToken: string) =>
  withDatabase(bindings, (database) =>
    Effect.runPromise(
      makeQualificationCohortScrubDispatchAuthority(database).claimBatch(
        claimToken,
        qualificationCohortScrubDispatchBatchLimit,
      ),
    ),
  );

const reconcileClaim = (
  claim: QualificationCohortScrubDispatchClaim,
  bindings: Bindings,
): Effect.Effect<
  void,
  | QualificationCohortScrubDispatchUnavailable
  | QualificationCohortScrubDispatchConflict
  | QualificationCohortScrubDispatchRetryable
> => {
  if (claim._tag === "Completed") {
    return Effect.tryPromise({
      try: () => ports(bindings).completionAuthority(claim, claim.rootChecksum),
      catch: (cause) =>
        new QualificationCohortScrubDispatchUnavailable({
          cause,
          operation: "inspectCompletedDispatch",
        }),
    }).pipe(
      Effect.flatMap((authority) =>
        authority === "Ready"
          ? Effect.void
          : Effect.fail(
              new QualificationCohortScrubDispatchConflict({
                message: `Settled root dispatch authority ${authority.toLowerCase()}`,
              }),
            ),
      ),
    );
  }
  if (claim._tag === "Claimed")
    return reconcileQualificationCohortScrubDispatch(claim, ports(bindings));
  return Effect.fail(
    new QualificationCohortScrubDispatchUnavailable({
      cause: claim,
      operation: "claimExact",
    }),
  );
};

export * as QualificationCohortScrubDispatchComposition from "./qualification-cohort-scrub-dispatch";
