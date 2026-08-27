import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { AllowancePeriodId, type AgentId } from "../domain";
import { Db } from "../db";
import { AccountDeletionCloudflare } from "../integrations/cloudflare/account-deletion";
import { AccountDeletionPostgres } from "../integrations/postgres/account-deletion";
import { AccountDeletion } from "../services/account-deletion";
import { WhatsAppWakeUps } from "../services/whatsapp-wakeups";

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
}

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
                        eq(allowanceUsage.source_type, "artifactProviderOperation"),
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
