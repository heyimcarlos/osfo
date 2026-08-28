import { documentBuildNotifications, documentBuilds } from "@osfo/db/schema/document-builds";
import { researchReportNotifications, researchReports } from "@osfo/db/schema/research-reports";
import { users } from "@osfo/db/schema/auth";
import { and, eq, gt, inArray, sql } from "drizzle-orm";

import type { Database } from "@osfo/db";
import type { UserId } from "../../domain";

/* oxlint-disable effecttsgo/async-function -- Drizzle transactions own this PostgreSQL serialization boundary. */

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const documentActiveStates = [
  "admitted",
  "accepted",
  "running",
  "preview_stored",
  "publication_committed",
  "cancel_requested",
] as const;

const researchActiveStates = [
  "admitted",
  "accepted",
  "running",
  "sources_committed",
  "artifact_stored",
  "publication_committed",
  "cancel_requested",
] as const;

/** Lock one User row before the shared Workflow advisory identity, in that order everywhere. */
export const lockWorkflowUser = async (transaction: Transaction, userId: UserId | string) => {
  const [user] = await transaction
    .select({ userId: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .for("update");
  if (user === undefined) return false;
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`workflow:user:${userId}`}, 0))`,
  );
  return true;
};

/** Count every live Workflow family while the canonical User lock is held. */
export const countActiveWorkflows = async (transaction: Transaction, userId: UserId | string) => {
  const [builds, reports] = await Promise.all([
    transaction
      .select({ count: sql<number>`count(*)::integer` })
      .from(documentBuilds)
      .where(
        and(
          eq(documentBuilds.user_id, userId),
          inArray(documentBuilds.state, documentActiveStates),
        ),
      ),
    transaction
      .select({ count: sql<number>`count(*)::integer` })
      .from(researchReports)
      .where(
        and(
          eq(researchReports.user_id, userId),
          inArray(researchReports.state, researchActiveStates),
        ),
      ),
  ]);
  return (builds[0]?.count ?? 0) + (reports[0]?.count ?? 0);
};

/** Count every claimed progress milestone in the shared rolling User window. */
export const countWorkflowMilestones = async (
  transaction: Transaction,
  userId: UserId | string,
  windowStart: Date,
) => {
  const [builds, reports] = await Promise.all([
    transaction
      .select({ count: sql<number>`count(*)::integer` })
      .from(documentBuildNotifications)
      .where(
        and(
          eq(documentBuildNotifications.user_id, userId),
          eq(documentBuildNotifications.kind, "previewReady"),
          gt(documentBuildNotifications.claimed_at, windowStart),
        ),
      ),
    transaction
      .select({ count: sql<number>`count(*)::integer` })
      .from(researchReportNotifications)
      .where(
        and(
          eq(researchReportNotifications.user_id, userId),
          eq(researchReportNotifications.kind, "sourcesCollected"),
          gt(researchReportNotifications.claimed_at, windowStart),
        ),
      ),
  ]);
  return (builds[0]?.count ?? 0) + (reports[0]?.count ?? 0);
};
