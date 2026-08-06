import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { databaseSchema } from "../src/schema";

describe("database schema", () => {
  it("owns the complete durable message admission table set", () => {
    expect(Object.values(databaseSchema).map(getTableName).sort()).toEqual([
      "acceptance_receipts",
      "admission_global_capacity",
      "admission_principal_capacity",
      "agent_run_capacity_reservations",
      "agent_runs",
      "authentication_sessions",
      "outbox_obligations",
      "principals",
      "thread_events",
      "threads",
      "user_messages",
    ]);
  });
});
