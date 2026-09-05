/* oxlint-disable effecttsgo/async-function -- Worker callbacks and Agent RPC use Promise APIs. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions run inside the Effect-owned callback. */
import { expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Effect, Result } from "effect";
import { vi } from "vitest";
import { OsfoAgent } from "../../src/agents/osfo/agent";
import { AgentStorageErasure } from "../../src/agents/osfo/agent-storage-erasure";
import { AccountDeletionAgent } from "../../src/composition/account-deletion-agent";

it.effect.each([false, true])(
  "erases SQL and KV despite unsupported native deletion, with forgotten registry %s",
  (forgotten) =>
    Effect.promise(async () => {
      const stub = env.OSFO_DIRECTORY.getByName(`permanent-erasure-proof-${forgotten}`);
      await runInDurableObject(stub, async (directory, state) => {
        const agentId = "permanent-erasure-agent";
        const userId = "permanent-erasure-user";
        const input = initialization(agentId);
        const agent = await directory.subAgent(OsfoAgent, agentId);
        await agent.initialize(input);
        await agent.addMessages([
          {
            id: "retained-message",
            role: "user",
            parts: [{ type: "text", text: "Deletion sentinel" }],
          },
        ]);
        expect(await agent.readSession(input.sessionId)).toMatchObject({
          messages: [{ id: "retained-message" }],
        });
        const unrelatedInput = initialization("unrelated-agent");
        const unrelated = await directory.subAgent(OsfoAgent, unrelatedInput.agentId);
        await unrelated.initialize(unrelatedInput);
        await unrelated.addMessages([
          {
            id: "unrelated-message",
            role: "user",
            parts: [{ type: "text", text: "Unrelated sentinel" }],
          },
        ]);
        const nativeDelete = vi.spyOn(state.facets, "delete").mockImplementation(() => {
          throw new Error("Not supported");
        });
        // Authority and provider quiescence have their own tests; this fixture retains
        // the actual facet, database erasure, abort, registry removal and cold reopen.
        const authority = vi
          .spyOn(AccountDeletionAgent, "authorizeErasure")
          .mockReturnValue(Effect.void);
        const quiescence = vi
          .spyOn(OsfoAgent.prototype, "quiesceAccountDeletion")
          .mockResolvedValue(undefined);
        const erase = AgentStorageErasure.erase;
        const storageProof = vi
          .spyOn(AgentStorageErasure, "erase")
          .mockImplementation((storage) => {
            storage.kv.put("permanent-erasure-kv", "Private KV sentinel");
            storage.sql.exec("CREATE VIRTUAL TABLE permanent_erasure_search USING fts5(content)");
            storage.sql.exec(
              "INSERT INTO permanent_erasure_search(content) VALUES ('Private search sentinel')",
            );
            expect(Array.from(storage.kv.list()).length).toBeGreaterThan(0);
            return erase(storage).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  expect(
                    storage.sql
                      .exec(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_KV'",
                      )
                      .toArray(),
                  ).toEqual([]);
                  expect(Array.from(storage.kv.list())).toEqual([]);
                }),
              ),
            );
          });
        try {
          if (forgotten) {
            // Reproduce the old SDK's silent native failure and registry removal.
            await directory.deleteSubAgent(OsfoAgent, agentId);
            expect(await directory.inspectAgent(agentId)).toBeNull();
          }
          await directory.deleteAgent(agentId, userId);
          expect(storageProof).toHaveBeenCalledOnce();
          expect(authority).toHaveBeenCalledWith(agentId, userId);
          expect(quiescence).toHaveBeenCalledWith(userId);
          expect(await directory.inspectAgent(agentId)).toBeNull();
          expect(directory.listAgents()).toEqual([
            { className: "OsfoAgent", name: unrelatedInput.agentId },
          ]);
          const reopened = await directory.subAgent(OsfoAgent, agentId);
          await reopened.initialize(input);
          expect(await reopened.readSession(input.sessionId)).toMatchObject({ messages: [] });
          expect(await unrelated.readSession(unrelatedInput.sessionId)).toMatchObject({
            messages: [
              { id: "unrelated-message", parts: [{ type: "text", text: "Unrelated sentinel" }] },
            ],
          });
        } finally {
          storageProof.mockRestore();
          quiescence.mockRestore();
          authority.mockRestore();
          nativeDelete.mockRestore();
        }
      });
    }),
);

it.effect("retains the Agent registration and SQL/KV after erasure failure, then retries", () =>
  Effect.promise(async () => {
    const stub = env.OSFO_DIRECTORY.getByName("permanent-erasure-retry");
    await runInDurableObject(stub, async (directory) => {
      const input = initialization("permanent-erasure-retry-agent");
      const agent = await directory.subAgent(OsfoAgent, input.agentId);
      await agent.initialize(input);
      await agent.addMessages([
        {
          id: "retry-message",
          role: "user",
          parts: [{ type: "text", text: "Retain until erased" }],
        },
      ]);
      const authority = vi
        .spyOn(AccountDeletionAgent, "authorizeErasure")
        .mockReturnValue(Effect.void);
      const quiescence = vi
        .spyOn(OsfoAgent.prototype, "quiesceAccountDeletion")
        .mockResolvedValue(undefined);
      const erase = AgentStorageErasure.erase;
      const failure = vi.spyOn(AgentStorageErasure, "erase").mockImplementationOnce((storage) => {
        storage.kv.put("retry-kv", "Retained KV");
        storage.sql.exec(
          "CREATE TABLE erase_cycle_left (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES erase_cycle_right(id))",
        );
        storage.sql.exec(
          "CREATE TABLE erase_cycle_right (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES erase_cycle_left(id))",
        );
        return erase(storage).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              expect(storage.kv.get("retry-kv")).toBe("Retained KV");
              expect(
                storage.sql
                  .exec("SELECT name FROM sqlite_master WHERE name='erase_cycle_left'")
                  .toArray(),
              ).toHaveLength(1);
              storage.sql.exec("DROP TABLE erase_cycle_left");
              storage.sql.exec("DROP TABLE erase_cycle_right");
            }),
          ),
        );
      });
      try {
        const result = await Effect.runPromise(
          Effect.tryPromise(() => directory.deleteAgent(input.agentId, "retry-user")).pipe(
            Effect.result,
          ),
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(directory.listAgents()).toEqual([{ className: "OsfoAgent", name: input.agentId }]);
        expect(await agent.readSession(input.sessionId)).toMatchObject({
          messages: [{ id: "retry-message" }],
        });
        await directory.deleteAgent(input.agentId, "retry-user");
        expect(directory.listAgents()).toEqual([]);
        const reopened = await directory.subAgent(OsfoAgent, input.agentId);
        await reopened.initialize(input);
        expect(await reopened.readSession(input.sessionId)).toMatchObject({ messages: [] });
      } finally {
        failure.mockRestore();
        quiescence.mockRestore();
        authority.mockRestore();
      }
    });
  }),
);

const initialization = (agentId: string) => ({
  agentId,
  initializationId: `${agentId}-initialization`,
  initializedAt: "2026-08-27T12:00:00.000Z",
  routeId: `${agentId}-route`,
  sessionId: `${agentId}-session`,
});
