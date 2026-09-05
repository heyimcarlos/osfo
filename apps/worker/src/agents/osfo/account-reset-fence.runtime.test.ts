/* oxlint-disable effecttsgo/async-function -- Cloudflare test callbacks and Agent RPC use Promise boundaries. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions run inside the Effect-owned Durable Object callback. */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AgentId, PlanPolicyVersion, UserId } from "../../domain";
import { AuthSessionId } from "../../domain/auth-session";
import { emptyLiveResourceFacts } from "../../services/authorization";
import { OsfoAgent } from "./agent";
import { AccountResetFence } from "./account-reset-fence";

it.effect("restores the reset fence before a fresh Agent admits ordinary RPC work", () =>
  Effect.promise(async () => {
    // SAFETY: wrangler.runtime.jsonc binds this namespace directly to OsfoAgent.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Generated production Env omits the runtime test binding.
    const runtimeEnv = env as typeof env & {
      readonly OSFO_AGENT_TEST: DurableObjectNamespace<OsfoAgent>;
    };
    const stub = runtimeEnv.OSFO_AGENT_TEST.getByName("account-reset-restart");
    await runInDurableObject(stub, async (_boundAgent, state) => {
      const userId = UserId.make("reset-runtime-user");
      const reset = AccountResetFence.make(state.storage.kv);
      const beforeReset = new OsfoAgent(state, runtimeEnv);
      const initialized = await beforeReset.initialize({
        agentId: AgentId.make("account-reset-restart"),
        initializationId: "reset-runtime-initialization",
        initializedAt: "2026-08-27T12:00:00.000Z",
        routeId: "reset-runtime-route",
        sessionId: "reset-runtime-session",
      });
      expect(initialized).toMatchObject({ _tag: "AgentInitialized" });
      await Effect.runPromise(reset.persist(userId));
      const agent = new OsfoAgent(state, runtimeEnv);
      const outcome = await agent.inspectCoreMemory({
        actionId: "reset-runtime-inspect",
        authorization: {
          allowance: { _tag: "Unavailable" },
          approval: null,
          authority: null,
          deletionAccess: { _tag: "DeletionAccessAvailable" },
          gmailConnection: null,
          integrationConnections: [],
          liveFacts: emptyLiveResourceFacts,
          // oxlint-disable-next-line effecttsgo/global-date -- Fixed transport fixture for a rejected request.
          now: new Date("2026-08-27T12:00:00.000Z"),
          originatingAuthority: {
            _tag: "AuthSession",
            authSessionId: AuthSessionId.make("runtime-auth"),
          },
          requestVendorUsdMicros: 0n,
          resourceOwnerUserId: userId,
          subscription: { plan: "free", planPolicyVersion: PlanPolicyVersion.make("launch-v1") },
          user: { _tag: "ActiveUser", userId },
        },
      });
      expect(outcome).toMatchObject({ _tag: "CoreMemoryUnavailable", operation: "inspect" });
      expect(await Effect.runPromise(AccountResetFence.make(state.storage.kv).isFenced)).toBe(true);
    });
  }),
);
