import { describe, expect, it } from "@effect/vitest";
import { getTableName } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { InvalidMessageAdmissionDatabaseConfig, makeMessageAdmissionLayer } from "../src/index";
import { databaseSchema } from "../src/schema";

describe("database schema", () => {
  it("owns the durable message and deterministic AgentRun authority tables", () => {
    expect(Object.values(databaseSchema).map(getTableName).sort()).toEqual([
      "acceptance_receipts",
      "admission_global_capacity",
      "admission_principal_capacity",
      "agent_run_capacity_reservations",
      "agent_runs",
      "assistant_outputs",
      "authentication_sessions",
      "model_call_attempts",
      "model_call_fragments",
      "model_calls",
      "outbox_obligations",
      "principals",
      "relay_dispatch_capacity",
      "relay_principals",
      "relay_threads",
      "thread_events",
      "threads",
      "user_messages",
    ]);
  });

  it.effect("rejects invalid database adapter configuration before connecting", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Effect.scoped(
          Layer.build(
            makeMessageAdmissionLayer({
              databaseUrl: "",
              executionProfileRef: "test",
              globalNonTerminalLimit: 1,
              principalNonTerminalLimit: 1,
            }),
          ),
        ),
      );

      expect(error).toBeInstanceOf(InvalidMessageAdmissionDatabaseConfig);
    }),
  );
});
