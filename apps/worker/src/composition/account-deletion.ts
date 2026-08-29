import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
import { and, eq, inArray } from "drizzle-orm";
import { DateTime, Effect, Layer } from "effect";

import type { Database } from "@osfo/db";
import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { AllowancePeriodId, type AgentId, type UserId } from "../domain";
import { Db } from "../db";
import { AccountDeletionCloudflare } from "../integrations/cloudflare/account-deletion";
import { AccountDeletionPostgres } from "../integrations/postgres/account-deletion";
import { ResearchReportPostgres } from "../integrations/postgres/research-report";
import { DocumentBuildPostgres } from "../integrations/postgres/document-build";
import { AccountDeletion } from "../services/account-deletion";
import { WhatsAppWakeUps } from "../services/whatsapp-wakeups";
import { ResearchReportComposition } from "./research-report";
import { DocumentBuildComposition } from "./document-build";
import { ScheduledEmailComposition } from "./scheduled-email";
import { ScheduledEmailPostgres } from "../integrations/postgres/scheduled-email";

/* oxlint-disable effecttsgo/async-function, eslint/no-underscore-dangle -- Closed capability variants use the canonical _tag discriminator, and the deletion preflight adapts one Promise transaction at its Effect boundary. */

interface DirectoryDeletionStub {
  readonly deleteAgent: (agentId: string) => Promise<void>;
  readonly quiesceAgentAccountDeletion: (agentId: string, userId: string) => Promise<void>;
}

/** Closed runtime state for the not-yet-delivered integration-authority owner. */
export type IntegrationAuthorityDeletionCapability =
  | { readonly _tag: "NotDelivered" }
  | {
      readonly _tag: "Delivered";
      readonly adapter: AccountDeletion.PortInterface["integrations"] | null;
    };

/** Current production truth: no integration connection persistence has been delivered. */
export const integrationAuthorityDeletionNotDelivered: IntegrationAuthorityDeletionCapability = {
  _tag: "NotDelivered",
};

/** Concrete bindings used by the broader account-deletion flow. */
export interface Bindings {
  readonly ARTIFACTS?: R2Bucket;
  readonly FILES?: R2Bucket;
  readonly integrationAuthorityDeletion: IntegrationAuthorityDeletionCapability;
  readonly OSFO_DIRECTORY: {
    readonly getByName: (identity: string) => DirectoryDeletionStub;
  };
  readonly DOCUMENT_BUILD_TIMER_WORKFLOW?: DocumentBuildComposition.WorkflowBinding;
  readonly DOCUMENT_BUILD_WORKFLOW?: DocumentBuildComposition.WorkflowBinding;
  readonly RESEARCH_REPORT_TIMER_WORKFLOW?: ResearchReportComposition.WorkflowBinding;
  readonly RESEARCH_REPORT_WORKFLOW?: ResearchReportComposition.WorkflowBinding;
  readonly SCHEDULED_EMAIL_WORKFLOW?: ScheduledEmailComposition.WorkflowBinding;
}

/** Quiesce every Workflow family under its shared User lock before account erasure. */
export const quiesceWorkflows = (bindings: Bindings, database: Database, userId: UserId) => {
  if (
    bindings.RESEARCH_REPORT_WORKFLOW === undefined ||
    bindings.RESEARCH_REPORT_TIMER_WORKFLOW === undefined ||
    bindings.DOCUMENT_BUILD_WORKFLOW === undefined ||
    bindings.DOCUMENT_BUILD_TIMER_WORKFLOW === undefined ||
    bindings.SCHEDULED_EMAIL_WORKFLOW === undefined
  ) {
    return Effect.fail(
      new AccountDeletion.AccountDeletionUnavailable({
        cause: "missing Workflow bindings",
        message: "Workflow account-deletion quiescence is unavailable",
        operation: "quiesceWorkflows",
      }),
    );
  }
  const workflow = ResearchReportComposition.makeWorkflowPort(
    bindings.RESEARCH_REPORT_WORKFLOW,
    bindings.RESEARCH_REPORT_TIMER_WORKFLOW,
  );
  const documentWorkflow = DocumentBuildComposition.makeWorkflowPort(
    bindings.DOCUMENT_BUILD_WORKFLOW,
    bindings.DOCUMENT_BUILD_TIMER_WORKFLOW,
  );
  const scheduledEmailWorkflow = ScheduledEmailComposition.makeWorkflowPort(
    bindings.SCHEDULED_EMAIL_WORKFLOW,
  );
  return Effect.gen(function* () {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    const [instanceIds, documentQuiescence, scheduledEmailQuiescence] = yield* Effect.all([
      ResearchReportPostgres.quiesceForAccountDeletion(database, userId, now),
      DocumentBuildPostgres.quiesceForAccountDeletion(database, userId, now),
      ScheduledEmailPostgres.quiesceForAccountDeletion(database, userId, now),
    ]).pipe(
      Effect.mapError(
        (cause) =>
          new AccountDeletion.AccountDeletionUnavailable({
            cause,
            message: "Workflow product truth could not be terminalized",
            operation: "quiesceWorkflows",
          }),
      ),
    );
    yield* Effect.all(
      [
        Effect.forEach(instanceIds, workflow.terminate, { concurrency: 2, discard: true }),
        Effect.forEach(
          documentQuiescence._tag === "Ready" ? documentQuiescence.instances : [],
          ({ main, timer }) => documentWorkflow.terminate(main, timer),
          { concurrency: 2, discard: true },
        ),
        Effect.forEach(scheduledEmailQuiescence.instances, scheduledEmailWorkflow.terminate, {
          concurrency: 2,
          discard: true,
        }),
      ],
      { concurrency: 2, discard: true },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new AccountDeletion.AccountDeletionUnavailable({
            cause,
            message: "Workflow execution hosts could not be terminated",
            operation: "quiesceWorkflows",
          }),
      ),
    );
    if (documentQuiescence._tag === "RecoveryPending") {
      return yield* new AccountDeletion.AccountDeletionUnavailable({
        cause: documentQuiescence.workflowIds,
        message: "A committed Document Build publication is still recovering",
        operation: "quiesceWorkflows",
      });
    }
    if (scheduledEmailQuiescence._tag === "RecoveryPending") {
      return yield* new AccountDeletion.AccountDeletionUnavailable({
        cause: scheduledEmailQuiescence.workflowIds,
        message: "A claimed Scheduled Email send is still reconciling",
        operation: "quiesceWorkflows",
      });
    }
    return undefined;
  });
};

/** Compose provider-independent local account erasure boundaries. */
const makePort = (bindings: Bindings) =>
  Effect.gen(function* () {
    const database = yield* Db.database;
    return AccountDeletion.Port.of({
      inspectAuthorization: AccountDeletionPostgres.inspectAuthorization(database),
      agents: {
        quiesce: (agentId: AgentId, userId) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: async () => {
                const deleted = await WhatsAppWakeUps.deleteUserRowsBeforeAgentTeardown(
                  database,
                  userId,
                );
                if (!deleted) throw new Error("A WhatsApp provider request is still in flight");
              },
              catch: (cause) =>
                new AccountDeletion.AccountDeletionUnavailable({
                  cause,
                  message: "WhatsApp Wake-up deletion preflight is unavailable",
                  operation: "deleteWhatsAppWakeUps",
                }),
            });
            yield* Effect.tryPromise({
              try: () =>
                bindings.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME).quiesceAgentAccountDeletion(
                  agentId,
                  userId,
                ),
              catch: (cause) =>
                new AccountDeletion.AccountDeletionUnavailable({
                  cause,
                  message: "Agent provider activity could not be quiesced",
                  operation: "quiesceAgentAccountDeletion",
                }),
            });
          }),
        remove: (agentId: AgentId) =>
          Effect.tryPromise({
            try: () => bindings.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME).deleteAgent(agentId),
            catch: (cause) =>
              new AccountDeletion.AccountDeletionUnavailable({
                cause,
                message: "Agent SQLite deletion is unavailable",
                operation: "deleteAgent",
              }),
          }),
      },
      integrations: integrationDeletionPort(bindings.integrationAuthorityDeletion),
      workflows: {
        quiesce: (userId) => quiesceWorkflows(bindings, database, userId),
      },
      objects:
        bindings.FILES === undefined || bindings.ARTIFACTS === undefined
          ? {
              remove: () =>
                Effect.fail(
                  new AccountDeletion.AccountDeletionUnavailable({
                    cause: "missing R2 bindings",
                    message: "R2 account deletion is unavailable",
                    operation: "removeObjects",
                  }),
                ),
            }
          : AccountDeletionCloudflare.make(bindings.FILES, bindings.ARTIFACTS, (userId) =>
              Db.execute("inspectAccountDeletionObjects", () =>
                Promise.all([
                  database
                    .select({ allowancePeriodId: allowancePeriods.allowance_period_id })
                    .from(allowancePeriods)
                    .where(eq(allowancePeriods.user_id, userId)),
                  database
                    .select({ providerOperationId: allowanceUsage.source_id })
                    .from(allowanceUsage)
                    .where(
                      and(
                        eq(allowanceUsage.user_id, userId),
                        inArray(allowanceUsage.source_type, [
                          "artifactProviderOperation",
                          "documentProviderOperation",
                        ]),
                      ),
                    ),
                ]).then(([periods, reconciledOperations]) => ({
                  periods,
                  reconciledOperations,
                })),
              ).pipe(
                Effect.map(({ periods, reconciledOperations }) => ({
                  allowancePeriodIds: new Set(
                    periods.map(({ allowancePeriodId }) =>
                      AllowancePeriodId.make(allowancePeriodId),
                    ),
                  ),
                  reconciledArtifactProviderOperationIds: new Set(
                    reconciledOperations.map(({ providerOperationId }) => providerOperationId),
                  ),
                })),
                Effect.mapError(
                  (cause) =>
                    new AccountDeletion.AccountDeletionUnavailable({
                      cause,
                      message: "Document ownership evidence is unavailable",
                      operation: "inspectAccountDeletionObjects",
                    }),
                ),
              ),
            ),
      persistence: AccountDeletionPostgres.make(database),
    });
  });

/** Runtime account-deletion boundaries backed by PostgreSQL, Durable Objects, and R2. */
export const portLayer = (bindings: Bindings) =>
  Layer.effect(AccountDeletion.Port, makePort(bindings));

/** Shared account-deletion capability used by HTTP and scheduled entry points. */
export const layer = (bindings: Bindings) =>
  AccountDeletion.layerWithoutDependencies.pipe(Layer.provide(portLayer(bindings)));

/** Resolve integration deletion only from an explicit delivered/not-delivered capability state. */
export const integrationDeletionPort = (
  capability: IntegrationAuthorityDeletionCapability,
): AccountDeletion.PortInterface["integrations"] => {
  if (capability._tag === "NotDelivered") {
    return { pending: () => Effect.succeed([]), revoke: integrationDeletionUnavailable };
  }
  if (capability.adapter !== null) return capability.adapter;
  return {
    pending: () => integrationDeletionUnavailable("enabled integration authority discovery"),
    revoke: (target) => integrationDeletionUnavailable(target),
  };
};

const integrationDeletionUnavailable = (cause: unknown) =>
  Effect.fail(
    new AccountDeletion.AccountDeletionUnavailable({
      cause,
      message: "Integration authority deletion is unavailable",
      operation: "deleteIntegrationAuthority",
    }),
  );

export * as AccountDeletionComposition from "./account-deletion";
