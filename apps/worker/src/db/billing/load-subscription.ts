import { billingSubscriptions } from "@osfo/db/schema/billing";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import type { UserId } from "../../domain";
import type { Persistence } from "../../services/billing-subscriptions";
import type { BillingDatabase } from "./database";
import { DatabaseUnavailable } from "./errors";
import { runBillingTransaction } from "./transaction";

/* oxlint-disable effecttsgo/async-function -- Drizzle owns this transaction Promise boundary. */

/** Load the optimistic revision for one User's billing Subscription. */
export const loadSubscription = (
  database: BillingDatabase,
  userId: UserId,
): ReturnType<Persistence["load"]> =>
  runBillingTransaction("loadBillingSubscription", () =>
    database.transaction(async (transaction) => {
      const [row] = await transaction
        .select({ updatedAt: billingSubscriptions.updatedAt })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.userId, userId))
        .limit(1);
      return row;
    }),
  ).pipe(
    Effect.flatMap((row) =>
      row === undefined
        ? Effect.fail(
            new DatabaseUnavailable({
              cause: { userId },
              message: "The User has no billing Subscription",
              operation: "loadBillingSubscription",
            }),
          )
        : Effect.succeed(row),
    ),
  );
