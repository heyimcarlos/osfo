/* oxlint-disable effecttsgo/strict-effect-provide -- This application composition boundary supplies the complete request-scoped database Layer. */
import { DateTime, Effect } from "effect";

import type { AllowancePeriodId, UserId } from "../domain";
import type { ActionId } from "../domain/action-execution";
import { retainedCatalog } from "../domain/plan-policy";
import { Db } from "../db";
import { BillingDb } from "../db/billing";
import { Allowances } from "../services/allowances";
import { Integrations } from "../services/integrations";

export const recordUsage = Effect.fn("ImmediateGmailSendComposition.recordUsage")(
  (
    db: Pick<Hyperdrive, "connectionString">,
    input: {
      readonly actionId: ActionId;
      readonly allowancePeriodId: AllowancePeriodId;
      readonly basis: "conservative" | "observed";
      readonly userId: UserId;
    },
  ) =>
    Effect.scoped(
      Db.database.pipe(
        Effect.flatMap((database) =>
          Allowances.make({
            billing: BillingDb.make(database),
            catalog: retainedCatalog,
            now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
          }).recordForUser(
            input.userId,
            input.allowancePeriodId,
            { sourceId: input.actionId, sourceType: "integrationAction" },
            [{ allowanceKind: "gmailSends", basis: input.basis, quantity: 1n }],
          ),
        ),
        Effect.provide(Db.layer({ db })),
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new Integrations.IntegrationEffectFinalizationUnavailable({
              cause,
              message: "Gmail Action accounting is unavailable",
              operation: "accounting.gmailSend",
            }),
        ),
      ),
    ),
);

export * as ImmediateGmailSendComposition from "./immediate-gmail-send";
