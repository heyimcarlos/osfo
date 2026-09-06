/* oxlint-disable effecttsgo/async-function -- Worker callbacks and Agent RPC use Promise APIs. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions run inside the Effect-owned callback. */
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Effect, Result } from "effect";
import { AgentStorageErasure } from "../../src/agents/osfo/agent-storage-erasure";
import { OsfoAgent } from "../../src/agents/osfo/agent";
import { AccountResetComposition } from "../../src/composition/account-reset";
import { emptyLiveResourceFacts } from "../../src/services/authorization";
import { AgentId, UserId, PlanPolicyVersion, AllowancePeriodId } from "../../src/domain";
import { AuthSessionId } from "../../src/domain/auth-session";

it.effect(
  "erases facet history, Core Memory and reset fence before reopening the same identity",
  () =>
    Effect.promise(async () => {
      const stub = env.OSFO_DIRECTORY.getByName("reset-erasure-lifecycle");
      await runInDurableObject(stub, async (directory) => {
        const agentId = AgentId.make("reset-erasure-agent");
        const userId = UserId.make("reset-erasure-user");
        const input = {
          agentId,
          initializationId: "reset-erasure-initialization",
          initializedAt: "2026-08-27T12:00:00.000Z",
          routeId: "reset-erasure-route",
          sessionId: "reset-erasure-session",
        };
        // oxlint-disable-next-line effecttsgo/global-date -- Fixed authorization fixture.
        const now = new Date("2026-08-27T12:00:00.000Z");
        // oxlint-disable-next-line effecttsgo/global-date -- Fixed authorization fixture.
        const expiresAt = new Date("2026-08-27T13:00:00.000Z");
        const authorization = {
          allowance: {
            _tag: "Metered" as const,
            allowancePeriodId: AllowancePeriodId.make("reset-erasure-allowance"),
            startsAt: now,
            endsAt: expiresAt,
            plan: "free" as const,
            planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
            usage: [],
          },
          approval: null,
          authority: {
            _tag: "AuthSession" as const,
            authSessionId: AuthSessionId.make("reset-erasure-auth"),
            expiresAt,
            userId,
          },
          deletionAccess: { _tag: "DeletionAccessAvailable" as const },
          gmailConnection: null,
          integrationConnections: [],
          liveFacts: emptyLiveResourceFacts,
          now,
          originatingAuthority: {
            _tag: "AuthSession" as const,
            authSessionId: AuthSessionId.make("reset-erasure-auth"),
          },
          requestVendorUsdMicros: 0n,
          resourceOwnerUserId: userId,
          subscription: {
            plan: "free" as const,
            planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
          },
          user: { _tag: "ActiveUser" as const, userId },
        };
        const agent = await directory.subAgent(OsfoAgent, agentId);
        expect(await agent.initialize(input)).toMatchObject({ _tag: "AgentInitialized" });
        await agent.addMessages([
          { id: "old-message", role: "user", parts: [{ type: "text", text: "Old conversation" }] },
        ]);
        expect(
          await agent.correctCoreMemory({
            actionId: "seed-memory",
            authorization,
            block: "userContext",
            content: "Old context",
          }),
        ).toMatchObject({ _tag: "CoreMemoryCorrected" });
        expect(await agent.readSession(input.sessionId)).toMatchObject({
          messages: [{ id: "old-message" }],
        });
        // Domain tests cover exact owner and suspension rejection. This runtime fixture
        // replaces only PostgreSQL authorization and transport, keeping real facet cleanup.
        const authority = vi
          .spyOn(AccountResetComposition, "authorize")
          .mockReturnValue(Effect.void);
        const transport = vi
          .spyOn(directory, "quiesceAgentAccountReset")
          .mockResolvedValue(undefined);
        try {
          await agent.quiesceAccountReset(userId);
          expect(
            await agent.inspectCoreMemory({ actionId: "before-erasure", authorization }),
          ).toMatchObject({ _tag: "CoreMemoryUnavailable" });
          expect(await directory.eraseAgentAccountReset(agentId, userId)).toEqual({
            storageResetVerified: true,
          });
          const reopened = await directory.subAgent(OsfoAgent, agentId);
          expect(await reopened.initialize(input)).toMatchObject({ _tag: "AgentInitialized" });
          expect(await reopened.readSession(input.sessionId)).toMatchObject({
            _tag: "SessionHistoryFound",
            messages: [],
          });
          expect(
            await reopened.inspectCoreMemory({ actionId: "after-erasure", authorization }),
          ).toMatchObject({
            _tag: "CoreMemoryInspected",
            userContext: { content: "" },
            agentNotes: { content: "" },
          });
          expect(await reopened.inspectReminderVerificationState(userId)).toMatchObject({
            reminderCount: 0,
            occurrenceCount: 0,
            agentScheduleCount: 0,
          });
        } finally {
          authority.mockRestore();
          transport.mockRestore();
        }
      });
    }),
);

it.effect(
  "rolls back table erasure and retains KV when table ownership cannot be fully erased",
  () =>
    Effect.promise(async () => {
      const stub = env.OSFO_DIRECTORY.getByName("reset-erasure-rollback");
      await runInDurableObject(stub, async (_directory, state) => {
        state.storage.sql.exec(
          "CREATE TABLE reset_cycle_left (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES reset_cycle_right(id))",
        );
        state.storage.sql.exec(
          "CREATE TABLE reset_cycle_right (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES reset_cycle_left(id))",
        );
        state.storage.sql.exec("CREATE VIRTUAL TABLE reset_search USING fts5(content)");
        state.storage.sql.exec(
          "INSERT INTO reset_search(content) VALUES ('retained until complete erasure')",
        );
        state.storage.kv.put("reset-proof", true);
        const result = await Effect.runPromise(
          AgentStorageErasure.erase(state.storage).pipe(Effect.result),
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(state.storage.kv.get("reset-proof")).toBe(true);
        expect(
          state.storage.sql
            .exec<{ count: number }>("SELECT COUNT(*) AS count FROM reset_search")
            .one().count,
        ).toBe(1);
      });
    }),
);
