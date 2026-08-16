import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { AgentId, AgentInitializationId, ConversationRouteId, SessionId } from "../src/domain";
import { DbTimestamp } from "../src/db";
import { makeAgentDb } from "../src/agents/osfo/db/client";
import {
  agentMigrations,
  type AgentMigration,
  applyMigrationChain,
} from "../src/agents/osfo/db/migrate";
import { makeAgentStore } from "../src/agents/osfo/db/store";
import {
  agentInitialization,
  committedTurns,
  conversationRoutes,
  sessionOwnership,
} from "../src/agents/osfo/db/schema";

/* oxlint-disable effecttsgo/async-function, effecttsgo/prefer-typed-schema-decoder, effecttsgo/run-effect-inside-effect, effecttsgo/schema-sync-in-effect, eslint/no-await-in-loop, eslint/no-underscore-dangle -- Worker integration tests cross Promise, RPC, Effect, and raw SQLite test boundaries. */

describe("Osfo Agent and Think Session foundation", () => {
  it.effect("keeps the Agent identity stable when its activation is replaced", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-stable");
      const initializationId = Schema.decodeUnknownSync(AgentInitializationId)("init-stable");
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-primary");
      const sessionId = Schema.decodeUnknownSync(SessionId)("session-primary");
      const agent = env.OSFO_AGENT.getByName(agentId);

      const initialized = yield* Effect.promise(() =>
        (async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId,
          }))(),
      );
      const repeatedInitialization = yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId,
          }),
      );
      const firstActivation = yield* Effect.promise(async () => await agent.probeRuntime());

      yield* Effect.promise(() => evictDurableObject(agent));

      const found = yield* Effect.promise(async () => await agent.inspect());
      const replacementActivation = yield* Effect.promise(async () => await agent.probeRuntime());

      expect(initialized).toEqual({
        _tag: "AgentInitialized",
        agentId: "agent-stable",
        currentSessionId: "session-primary",
        routeId: "route-primary",
      });
      expect(repeatedInitialization).toEqual(initialized);
      expect(found).toEqual({
        _tag: "AgentFound",
        agentId: "agent-stable",
        currentSessionId: "session-primary",
        routeId: "route-primary",
      });
      expect(replacementActivation).toHaveProperty("activationId");
      expect(firstActivation).toHaveProperty("activationId");
      if ("activationId" in replacementActivation && "activationId" in firstActivation) {
        expect(replacementActivation.activationId).not.toBe(firstActivation.activationId);
      }
    }),
  );

  it.effect("keeps exactly one current Session and retains route history", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-route-history");
      const initializationId =
        Schema.decodeUnknownSync(AgentInitializationId)("init-route-history");
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-history");
      const initialSessionId = Schema.decodeUnknownSync(SessionId)("session-initial");
      const replacementSessionId = Schema.decodeUnknownSync(SessionId)("session-replacement");
      const agent = env.OSFO_AGENT.getByName(agentId);

      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId: initialSessionId,
          }),
      );

      const firstReplacement = yield* Effect.promise(
        async () =>
          await agent.replaceCurrentSession({
            expectedCurrentSessionId: initialSessionId,
            replacedAt: "2026-08-15T13:00:00.000Z",
            replacementSessionId,
            routeId,
          }),
      );
      const repeatedReplacement = yield* Effect.promise(
        async () =>
          await agent.replaceCurrentSession({
            expectedCurrentSessionId: initialSessionId,
            replacedAt: "2026-08-15T13:00:00.000Z",
            replacementSessionId,
            routeId,
          }),
      );
      const route = yield* Effect.promise(async () => await agent.readRoute(routeId));

      expect(firstReplacement).toEqual({
        _tag: "CurrentSessionReplaced",
        currentSessionId: "session-replacement",
        historicalSessionId: "session-initial",
        routeId: "route-history",
      });
      expect(repeatedReplacement).toEqual(firstReplacement);
      expect(route).toEqual({
        _tag: "ConversationRouteFound",
        currentSessionId: "session-replacement",
        historicalSessionIds: ["session-initial"],
        routeId: "route-history",
      });
    }),
  );

  it.effect("enforces Agent-local ownership and idempotency invariants in SQLite", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-database-invariants");
      const initializationId = Schema.decodeUnknownSync(AgentInitializationId)(
        "init-database-invariants",
      );
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-database-invariants");
      const sessionId = Schema.decodeUnknownSync(SessionId)("session-database-invariants");
      const otherAgentId = Schema.decodeUnknownSync(AgentId)("other-agent");
      const otherInitializationId =
        Schema.decodeUnknownSync(AgentInitializationId)("other-initialization");
      const secondaryRouteId = Schema.decodeUnknownSync(ConversationRouteId)("secondary-route");
      const missingRouteId = Schema.decodeUnknownSync(ConversationRouteId)("missing-route");
      const secondarySessionId = Schema.decodeUnknownSync(SessionId)("secondary-current");
      const secondCurrentSessionId = Schema.decodeUnknownSync(SessionId)("second-current");
      const orphanSessionId = Schema.decodeUnknownSync(SessionId)("orphan-session");
      const initializedAt = Schema.decodeUnknownSync(DbTimestamp)("2026-08-15T12:00:00.000Z");
      const agent = env.OSFO_AGENT.getByName(agentId);

      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId,
          }),
      );
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          const db = makeAgentDb(state.storage);
          expect(() =>
            db
              .insert(agentInitialization)
              .values({
                agentId: otherAgentId,
                initializationId: otherInitializationId,
                initializedAt,
                singletonKey: "agent",
              })
              .run(),
          ).toThrow(/constraint/i);
          expect(() =>
            db
              .insert(conversationRoutes)
              .values({ isPrimary: true, routeId: secondaryRouteId })
              .run(),
          ).toThrow(/constraint/i);

          db.insert(conversationRoutes)
            .values({ isPrimary: false, routeId: secondaryRouteId })
            .run();
          db.insert(sessionOwnership)
            .values({
              becameCurrentAt: initializedAt,
              replacedAt: null,
              routeId: secondaryRouteId,
              sessionId: secondarySessionId,
            })
            .run();
          expect(() =>
            db
              .insert(sessionOwnership)
              .values({
                becameCurrentAt: initializedAt,
                replacedAt: null,
                routeId: secondaryRouteId,
                sessionId: secondCurrentSessionId,
              })
              .run(),
          ).toThrow(/constraint/i);
          expect(() =>
            db
              .insert(sessionOwnership)
              .values({
                becameCurrentAt: initializedAt,
                replacedAt: null,
                routeId: missingRouteId,
                sessionId: orphanSessionId,
              })
              .run(),
          ).toThrow(/constraint/i);

          db.insert(committedTurns)
            .values({
              assistantMessageId: "assistant-one",
              sessionId,
              source: "hook",
              thinkRequestId: "stable-think-request",
            })
            .run();
          expect(() =>
            db
              .insert(committedTurns)
              .values({
                assistantMessageId: "assistant-two",
                sessionId,
                source: "hook",
                thinkRequestId: "stable-think-request",
              })
              .run(),
          ).toThrow(/constraint/i);
        }),
      );
    }),
  );

  it.effect("reads canonical conversation history from the owned Think Session", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-canonical-read");
      const initializationId =
        Schema.decodeUnknownSync(AgentInitializationId)("init-canonical-read");
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-canonical-read");
      const sessionId = Schema.decodeUnknownSync(SessionId)("session-canonical-read");
      const agent = env.OSFO_AGENT.getByName(agentId);

      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId,
          }),
      );
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          await instance.session.appendMessage({
            id: "message-user",
            parts: [{ text: "Hello Osfo", type: "text" }],
            role: "user",
          });
          await instance.session.appendMessage({
            id: "message-assistant",
            parts: [{ text: "Hello back", type: "text" }],
            role: "assistant",
          });
        }),
      );

      const read = yield* Effect.promise(async () => await agent.readSession(sessionId));

      expect(read).toEqual({
        _tag: "CanonicalSessionFound",
        messages: [
          {
            id: "message-user",
            parts: [{ text: "Hello Osfo", type: "text" }],
            role: "user",
          },
          {
            id: "message-assistant",
            parts: [{ text: "Hello back", type: "text" }],
            role: "assistant",
          },
        ],
        sessionId: "session-canonical-read",
      });
    }),
  );

  it.effect("assigns and preserves committed-turn observation order through the hook", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-committed-hook");
      const initializationId =
        Schema.decodeUnknownSync(AgentInitializationId)("init-committed-hook");
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-committed-hook");
      const sessionId = Schema.decodeUnknownSync(SessionId)("session-committed-hook");
      const agent = env.OSFO_AGENT.getByName(agentId);

      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId,
          }),
      );
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          const completed = {
            continuation: false,
            message: {
              id: "assistant-z-first",
              parts: [{ text: "Committed response", type: "text" as const }],
              role: "assistant" as const,
            },
            requestId: "think-request-completed",
            status: "completed" as const,
          };
          await instance.onChatResponse(completed);
          await instance.onChatResponse({
            ...completed,
            message: { ...completed.message, id: "assistant-a-second" },
            requestId: "think-request-second",
          });
          await instance.onChatResponse(completed);
          await instance.onChatResponse({
            ...completed,
            message: { ...completed.message, id: "assistant-aborted" },
            requestId: "think-request-aborted",
            status: "aborted",
          });
        }),
      );

      const turns = yield* Effect.promise(async () => await agent.readCommittedTurns());

      expect(turns).toEqual([
        {
          assistantMessageId: "assistant-z-first",
          observationSequence: 1,
          observedAt: expect.any(String),
          sessionId: "session-committed-hook",
          source: "hook",
          thinkRequestId: "think-request-completed",
        },
        {
          assistantMessageId: "assistant-a-second",
          observationSequence: 2,
          observedAt: expect.any(String),
          sessionId: "session-committed-hook",
          source: "hook",
          thinkRequestId: "think-request-second",
        },
      ]);
    }),
  );

  it.effect("reconciles Sessions and canonical messages in deterministic order", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-turn-reconciliation");
      const initializationId = Schema.decodeUnknownSync(AgentInitializationId)(
        "init-turn-reconciliation",
      );
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-turn-reconciliation");
      const firstSessionId = Schema.decodeUnknownSync(SessionId)("session-turn-first");
      const secondSessionId = Schema.decodeUnknownSync(SessionId)("session-turn-second");
      const agent = env.OSFO_AGENT.getByName(agentId);

      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId: firstSessionId,
          }),
      );
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          for (const id of ["assistant-z-first", "assistant-a-second"]) {
            await instance.session.appendMessage({
              id,
              parts: [{ text: id, type: "text" }],
              role: "assistant",
            });
          }
        }),
      );
      yield* Effect.promise(
        async () =>
          await agent.replaceCurrentSession({
            expectedCurrentSessionId: firstSessionId,
            replacedAt: "2026-08-15T13:00:00.000Z",
            replacementSessionId: secondSessionId,
            routeId,
          }),
      );
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          for (const id of ["assistant-m-third", "assistant-b-fourth"]) {
            await instance.session.appendMessage({
              id,
              parts: [{ text: id, type: "text" }],
              role: "assistant",
            });
          }
        }),
      );
      yield* Effect.promise(() => evictDurableObject(agent));

      const firstActivation = yield* Effect.promise(async () => await agent.readCommittedTurns());
      yield* Effect.promise(() => evictDurableObject(agent));
      const secondActivation = yield* Effect.promise(async () => await agent.readCommittedTurns());

      expect(firstActivation).toEqual([
        {
          assistantMessageId: "assistant-z-first",
          observationSequence: 1,
          observedAt: expect.any(String),
          sessionId: "session-turn-first",
          source: "reconciliation",
          thinkRequestId: null,
        },
        {
          assistantMessageId: "assistant-a-second",
          observationSequence: 2,
          observedAt: expect.any(String),
          sessionId: "session-turn-first",
          source: "reconciliation",
          thinkRequestId: null,
        },
        {
          assistantMessageId: "assistant-m-third",
          observationSequence: 3,
          observedAt: expect.any(String),
          sessionId: "session-turn-second",
          source: "reconciliation",
          thinkRequestId: null,
        },
        {
          assistantMessageId: "assistant-b-fourth",
          observationSequence: 4,
          observedAt: expect.any(String),
          sessionId: "session-turn-second",
          source: "reconciliation",
          thinkRequestId: null,
        },
      ]);
      expect(secondActivation).toEqual(firstActivation);
    }),
  );

  it.effect("enriches a reconciled receipt without changing its observation identity", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-turn-enrichment");
      const initializationId =
        Schema.decodeUnknownSync(AgentInitializationId)("init-turn-enrichment");
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-turn-enrichment");
      const sessionId = Schema.decodeUnknownSync(SessionId)("session-turn-enrichment");
      const agent = env.OSFO_AGENT.getByName(agentId);

      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId,
          }),
      );
      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          await instance.session.appendMessage({
            id: "assistant-enriched",
            parts: [{ text: "Recovered response", type: "text" }],
            role: "assistant",
          });
        }),
      );
      const reconciled = yield* Effect.promise(async () => await agent.readCommittedTurns());

      yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          await instance.onChatResponse({
            continuation: false,
            message: {
              id: "assistant-enriched",
              parts: [{ text: "Recovered response", type: "text" }],
              role: "assistant",
            },
            requestId: "think-request-enriched",
            status: "completed",
          });
        }),
      );
      const enriched = yield* Effect.promise(async () => await agent.readCommittedTurns());

      expect(reconciled).toHaveLength(1);
      expect(enriched).toEqual([
        {
          assistantMessageId: "assistant-enriched",
          observationSequence: reconciled[0]?.observationSequence,
          observedAt: reconciled[0]?.observedAt,
          sessionId: "session-turn-enrichment",
          source: "hook",
          thinkRequestId: "think-request-enriched",
        },
      ]);
    }),
  );

  it.effect("returns typed conflicts for incompatible committed-turn identities", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-turn-conflicts");
      const initializationId =
        Schema.decodeUnknownSync(AgentInitializationId)("init-turn-conflicts");
      const routeId = Schema.decodeUnknownSync(ConversationRouteId)("route-turn-conflicts");
      const firstSessionId = Schema.decodeUnknownSync(SessionId)("session-conflict-first");
      const secondSessionId = Schema.decodeUnknownSync(SessionId)("session-conflict-second");
      const agent = env.OSFO_AGENT.getByName(agentId);

      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId,
            initializedAt: "2026-08-15T12:00:00.000Z",
            routeId,
            sessionId: firstSessionId,
          }),
      );
      yield* Effect.promise(
        async () =>
          await agent.replaceCurrentSession({
            expectedCurrentSessionId: firstSessionId,
            replacedAt: "2026-08-15T13:00:00.000Z",
            replacementSessionId: secondSessionId,
            routeId,
          }),
      );

      const conflicts = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          const store = makeAgentStore(makeAgentDb(state.storage));
          await Effect.runPromise(
            store.recordCommittedTurn({
              assistantMessageId: "assistant-stable-identity",
              sessionId: firstSessionId,
              source: "hook",
              thinkRequestId: "think-request-stable-identity",
            }),
          );
          const sessionConflict = await Effect.runPromise(
            Effect.flip(
              store.recordCommittedTurn({
                assistantMessageId: "assistant-stable-identity",
                sessionId: secondSessionId,
                source: "reconciliation",
                thinkRequestId: null,
              }),
            ),
          );
          const requestConflict = await Effect.runPromise(
            Effect.flip(
              store.recordCommittedTurn({
                assistantMessageId: "assistant-conflicting-identity",
                sessionId: secondSessionId,
                source: "hook",
                thinkRequestId: "think-request-stable-identity",
              }),
            ),
          );
          return { requestConflict, sessionConflict };
        }),
      );

      expect(conflicts.sessionConflict).toMatchObject({
        _tag: "CommittedTurnConflict",
        message: "The assistant message is already observed for another Session",
      });
      expect(conflicts.requestConflict).toMatchObject({
        _tag: "CommittedTurnConflict",
        message: "The Think request is already observed for another assistant message",
      });
    }),
  );

  it.effect("migrates every synthetic Agent SQLite source version and repeats safely", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName("agent-migration-source-versions");
      const reports = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          const observed = [];
          for (
            let sourceVersion = 0;
            sourceVersion <= syntheticMigrations.length;
            sourceVersion++
          ) {
            resetOsfoTables(state.storage);
            state.storage.sql.exec("DROP TABLE IF EXISTS synthetic_agent_state");
            const source = await Effect.runPromise(
              applyMigrationChain(state.storage, syntheticMigrations.slice(0, sourceVersion)),
            );
            const upgraded = await Effect.runPromise(
              applyMigrationChain(state.storage, syntheticMigrations),
            );
            const repeated = await Effect.runPromise(
              applyMigrationChain(state.storage, syntheticMigrations),
            );
            observed.push({ repeated, source, sourceVersion, upgraded });
          }
          return observed;
        }),
      );

      for (const report of reports) {
        expect(report.source.currentVersion).toBe(report.sourceVersion);
        expect(report.upgraded.appliedVersions).toEqual(
          syntheticMigrations.slice(report.sourceVersion).map(({ version }) => version),
        );
        expect(report.repeated).toEqual({
          appliedVersions: [],
          currentVersion: syntheticMigrations.length,
        });
      }
    }),
  );

  it.effect("rolls back an interrupted migration and retries it safely", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName("agent-migration-interruption");
      const observed = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          resetOsfoTables(state.storage);
          state.storage.sql.exec("CREATE TABLE osfo_committed_turns (blocked TEXT) STRICT");

          const failure = await Effect.runPromise(
            Effect.flip(applyMigrationChain(state.storage, agentMigrations)),
          );
          const initializationTableAfterFailure = state.storage.sql
            .exec<Record<string, SqlStorageValue>>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'osfo_agent_initialization'",
            )
            .toArray();

          state.storage.sql.exec("DROP TABLE osfo_committed_turns");
          const retry = await Effect.runPromise(
            applyMigrationChain(state.storage, agentMigrations),
          );
          return {
            failureTag: failure._tag,
            failureVersion: failure.version,
            retry,
            initializationTableAfterFailure,
          };
        }),
      );

      expect(observed).toEqual({
        failureTag: "AgentMigrationFailed",
        failureVersion: 1,
        initializationTableAfterFailure: [],
        retry: {
          appliedVersions: agentMigrations.map(({ version }) => version),
          currentVersion: agentMigrations.length,
        },
      });
    }),
  );

  it.effect("fails closed when an applied migration digest changes", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName("agent-migration-digest");
      const observed = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          resetOsfoTables(state.storage);
          await Effect.runPromise(applyMigrationChain(state.storage, agentMigrations));
          state.storage.sql.exec(
            "UPDATE osfo_schema_migrations SET digest = ? WHERE version = ?",
            "sha256:changed-after-application",
            1,
          );

          const failure = await Effect.runPromise(
            Effect.flip(applyMigrationChain(state.storage, agentMigrations)),
          );
          return {
            actualDigest:
              failure._tag === "AgentMigrationDigestMismatch" ? failure.actualDigest : undefined,
            failureTag: failure._tag,
            failureVersion: failure.version,
          };
        }),
      );

      expect(observed).toEqual({
        actualDigest: "sha256:changed-after-application",
        failureTag: "AgentMigrationDigestMismatch",
        failureVersion: 1,
      });
    }),
  );

  it.effect("rejects generated migration SQL that does not match its manifest digest", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName("agent-migration-definition-digest");
      const observed = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          resetOsfoTables(state.storage);
          const changed = agentMigrations.map((migration) => ({
            ...migration,
            sql: `${migration.sql}\nSELECT 1;`,
          }));
          const failure = await Effect.runPromise(
            Effect.flip(applyMigrationChain(state.storage, changed)),
          );
          const ledger = state.storage.sql
            .exec<Record<string, SqlStorageValue>>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'osfo_schema_migrations'",
            )
            .toArray();
          return { failureTag: failure._tag, ledger };
        }),
      );

      expect(observed).toEqual({ failureTag: "AgentMigrationDefinitionMismatch", ledger: [] });
    }),
  );

  it.effect("fails closed when Agent SQLite contains an unsupported future version", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName("agent-migration-future-version");
      const observed = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          resetOsfoTables(state.storage);
          state.storage.sql.exec(`CREATE TABLE osfo_schema_migrations (
            version INTEGER PRIMARY KEY,
            digest TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          ) STRICT`);
          state.storage.sql.exec(
            "INSERT INTO osfo_schema_migrations (version, digest) VALUES (?, ?)",
            agentMigrations.length + 1,
            "sha256:future-release",
          );
          const failure = await Effect.runPromise(
            Effect.flip(applyMigrationChain(state.storage, agentMigrations)),
          );
          return { failureTag: failure._tag, failureVersion: failure.version };
        }),
      );

      expect(observed).toEqual({
        failureTag: "AgentMigrationHistoryUnsupported",
        failureVersion: agentMigrations.length + 1,
      });
    }),
  );

  it.effect("leaves all Think-owned tables unchanged during Osfo migration", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName("agent-migration-think-isolation");
      const observed = yield* Effect.promise(() =>
        runInDurableObject(agent, async (_instance, state) => {
          resetOsfoTables(state.storage);
          const before = readNonOsfoTableDefinitions(state.storage);
          await Effect.runPromise(applyMigrationChain(state.storage, agentMigrations));
          return { after: readNonOsfoTableDefinitions(state.storage), before };
        }),
      );

      expect(observed.after).toEqual(observed.before);
      expect(observed.before.length).toBeGreaterThan(0);
    }),
  );
});

const resetOsfoTables = (storage: DurableObjectStorage): void => {
  storage.sql.exec("DROP TABLE IF EXISTS osfo_committed_turns");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_session_ownership");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_conversation_routes");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_agent_initialization");
  storage.sql.exec("DROP TABLE IF EXISTS osfo_schema_migrations");
};

const readNonOsfoTableDefinitions = (
  storage: DurableObjectStorage,
): ReadonlyArray<Record<string, SqlStorageValue>> =>
  storage.sql
    .exec<Record<string, SqlStorageValue>>(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'osfo_%' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .toArray();

const syntheticMigrations: ReadonlyArray<AgentMigration> = [
  {
    digest: "sha256:789ea8ca6fb02be481041b135659dbb205327d4015c228a8c4c7c9b16fab3f1e",
    sql: "CREATE TABLE synthetic_agent_state (id INTEGER PRIMARY KEY) STRICT",
    version: 1,
  },
  {
    digest: "sha256:5a3b7e272697e0395811e8706a0c277d7dd15b8ee82c1be1114bfc94e39f9804",
    sql: "ALTER TABLE synthetic_agent_state ADD COLUMN value TEXT",
    version: 2,
  },
  {
    digest: "sha256:7b8866281e4b0cc27e6945617130a048e1e6f6cb476b7c3c25e5421ebdea90dd",
    sql: "CREATE INDEX synthetic_agent_state_value ON synthetic_agent_state(value)",
    version: 3,
  },
];
