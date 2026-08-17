import { webhookEvents } from "@osfo/db/schema/webhooks";
import { eq, sql } from "drizzle-orm";

import type { Database } from "../index";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Drizzle owns this shared transaction Promise boundary and domain results use _tag. */

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Apply the one durable receive or replay transition for an existing webhook row. */
export const beginAttempt = async (
  transaction: Transaction,
  webhookEventId: string,
  status: "failed" | "pending" | "processed",
) => {
  if (status === "processed") return { _tag: "ProcessedDuplicate" } as const;
  await transaction
    .update(webhookEvents)
    .set({
      attempts: sql`${webhookEvents.attempts} + 1`,
      errorCode: null,
      status: "pending",
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(webhookEvents.webhookEventId, webhookEventId));
  return { _tag: "Pending", webhookEventId } as const;
};
