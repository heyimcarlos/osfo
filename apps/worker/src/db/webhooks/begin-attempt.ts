import { webhookJobs } from "@osfo/db/schema/webhooks";
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
  const [updated] = await transaction
    .update(webhookJobs)
    .set({
      attempts: sql`${webhookJobs.attempts} + 1`,
      error_code: null,
      status: "pending",
      updated_at: sql`clock_timestamp()`,
    })
    .where(eq(webhookJobs.webhook_event_id, webhookEventId))
    .returning({ attempts: webhookJobs.attempts });
  return updated === undefined
    ? ({ _tag: "ProcessedDuplicate" } as const)
    : ({ _tag: "Pending", attempt: updated.attempts, webhookEventId } as const);
};
