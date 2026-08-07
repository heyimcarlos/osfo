import { describe, expect, it } from "@effect/vitest";
import { getTableName } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  InvalidMessageAdmissionDatabaseConfig,
  InvalidThreadResumeDatabaseConfig,
  makeMessageAdmissionLayer,
  makeThreadResumeLayer,
} from "../src/index";
import { databaseSchema } from "../src/schema";

describe("database schema", () => {
  it("owns the durable message and deterministic AgentRun authority tables", () => {
    expect(Object.values(databaseSchema).map(getTableName).sort()).toEqual([
      "acceptance_receipts",
      "admission_global_capacity",
      "admission_principal_capacity",
      "admission_rejections",
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
      "relay_publication_attempts",
      "relay_publication_tasks",
      "relay_threads",
      "thread_events",
      "threads",
      "user_messages",
    ]);
  });

  it.effect("rejects an unbounded message admission database pool before connecting", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Effect.scoped(
          Layer.build(
            makeMessageAdmissionLayer({
              databaseUrl: "postgres://not-contacted.invalid/osfo",
              executionProfileRef: "test",
              globalNonTerminalLimit: 1,
              maxConnections: 0,
              principalNonTerminalLimit: 1,
            }),
          ),
        ),
      );

      expect(error).toBeInstanceOf(InvalidMessageAdmissionDatabaseConfig);
    }),
  );

  it.effect("rejects an unbounded Thread resume database pool before connecting", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Effect.scoped(
          Layer.build(
            makeThreadResumeLayer({
              cursorSecret: "local-reference-cursor-secret-change-in-production",
              databaseUrl: "postgres://not-contacted.invalid/osfo",
              maxConnections: 0,
              pollIntervalMs: 1,
              replayEventLimit: 1,
              replayGuaranteedForMs: 1,
              snapshotTimelineLimit: 1,
            }),
          ),
        ),
      );

      expect(error).toBeInstanceOf(InvalidThreadResumeDatabaseConfig);
    }),
  );
});
