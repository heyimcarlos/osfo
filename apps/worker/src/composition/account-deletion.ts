import type { Database } from "@osfo/db";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { AllowancePeriodId, type AgentId } from "../domain";
import { Db } from "../db";
import { AccountDeletionCloudflare } from "../integrations/cloudflare/account-deletion";
import { AccountDeletionPostgres } from "../integrations/postgres/account-deletion";
import { AccountDeletion } from "../services/account-deletion";

interface DirectoryDeletionStub {
  readonly deleteAgent: (agentId: string) => Promise<void>;
  readonly quiesceAgentMemoryProvider: (agentId: string, userId: string) => Promise<void>;
}

/** Concrete bindings used by the broader account-deletion flow. */
export interface Bindings {
  readonly ARTIFACTS?: R2Bucket;
  readonly FILES?: R2Bucket;
  readonly OSFO_DIRECTORY: {
    readonly getByName: (identity: string) => DirectoryDeletionStub;
  };
}

/** Compose provider-independent local account erasure boundaries. */
export const make = (database: Database, bindings: Bindings) =>
  AccountDeletion.make({
    authorize: AccountDeletionPostgres.authorize(database),
    agents: {
      quiesce: (agentId: AgentId, userId) =>
        Effect.tryPromise({
          try: () =>
            bindings.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME).quiesceAgentMemoryProvider(
              agentId,
              userId,
            ),
          catch: (cause) =>
            new AccountDeletion.AccountDeletionUnavailable({
              cause,
              message: "Agent provider activity could not be quiesced",
              operation: "quiesceAgentMemoryProvider",
            }),
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
              database
                .select({ allowancePeriodId: allowancePeriods.allowance_period_id })
                .from(allowancePeriods)
                .where(eq(allowancePeriods.user_id, userId)),
            ).pipe(
              Effect.map(
                (rows) =>
                  new Set(
                    rows.map(({ allowancePeriodId }) => AllowancePeriodId.make(allowancePeriodId)),
                  ),
              ),
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

export * as AccountDeletionComposition from "./account-deletion";
