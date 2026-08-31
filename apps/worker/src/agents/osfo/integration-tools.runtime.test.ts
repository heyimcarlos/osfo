/* oxlint-disable effecttsgo/async-function -- Durable Object and AI Tool test boundaries are Promise APIs. */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "@effect/vitest";
import { tool, type ModelMessage, type ToolSet, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Effect, Option, Schema } from "effect";

import { AgentId, ThinkSubmissionId, UserId } from "../../domain";
import { ManagedTurnMetadata } from "../../domain/managed-conversation";
import { Integrations } from "../../services/integrations";
import { OsfoAgent } from "./agent";
import { effectToolSchema } from "./effect-tool-schema";
import { IntegrationTools, type IntegrationToolExecutor } from "./integration-tools";

describe("Integration Tools", () => {
  it("publishes the curated reads and exact-approved Actions", () => {
    const definitions = IntegrationTools.make({
      executeEffect: vi.fn<IntegrationToolExecutor["executeEffect"]>(() =>
        Promise.reject(new Error("not executed")),
      ),
      executeRead: vi.fn<IntegrationToolExecutor["executeRead"]>(() =>
        Promise.reject(new Error("not executed")),
      ),
    });

    expect(Object.keys(definitions.tools)).toEqual([
      "calendarFindAvailability",
      "calendarListEvents",
      "driveGetMetadata",
      "driveReadFile",
      "driveSearch",
      "gmailFetchThread",
      "gmailSearchEmails",
    ]);
    expect(Object.keys(definitions.actions)).toEqual([
      "calendarCreateEvent",
      "calendarDeleteEvent",
      "calendarUpdateEvent",
      "driveDeliverArtifact",
      "gmailSendEmail",
    ]);
    for (const definition of Object.values(definitions.actions)) {
      expect(definition.config).toMatchObject({ approval: true, kind: "durable-pause" });
    }
  });
});

const runtimeUserId = UserId.make("integration-runtime-user");
const executedReads: Array<{ readonly operation: string; readonly userId: UserId }> = [];
const fakeIntegrations: Integrations.Interface = {
  connectLink: () => Effect.die(new Error("not used")),
  connectionEvidence: ({ toolkit, userId }) =>
    Effect.succeed(
      toolkit === "gmail"
        ? {
            _tag: "IntegrationConnectionConnected" as const,
            connectionBinding: Integrations.IntegrationConnectionBinding.make("a".repeat(64)),
            toolkit,
            userId,
          }
        : { _tag: "IntegrationConnectionMissing" as const, toolkit, userId },
    ),
  disconnect: ({ toolkit }) => Effect.succeed({ _tag: "IntegrationConnectionRevoked", toolkit }),
  execute: (input) =>
    input.authorize.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          executedReads.push({ operation: input.identity.operation, userId: input.userId });
        }),
      ),
      Effect.as({
        _tag: "IntegrationReadCompleted" as const,
        evidence: { providerLogIds: ["composio-runtime-log"] },
        manifestVersion: input.identity.manifestVersion,
        operation: input.identity.operation,
        records: [{ id: "message-1" }],
        responseBytes: 18n,
        toolkit: input.identity.toolkit,
        truncated: false,
      }),
    ),
  inspectAction: () => Effect.succeed({ _tag: "NotStarted" }),
  readActionStatus: () => Effect.succeed({ _tag: "NotStarted" }),
  resolveSession: (userId) =>
    Effect.succeed({ _tag: "IntegrationSessionResolved", resumed: true, userId }),
};

class IntegrationRuntimeAgent extends OsfoAgent {
  protected override makeIntegrations() {
    return Option.some(fakeIntegrations);
  }

  protected override authorizeIntegration() {
    return Effect.void;
  }
}

it("publishes and executes only the selected connected pack through OsfoAgent", async () => {
  // SAFETY: wrangler.runtime.jsonc owns this test-only direct binding to OsfoAgent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The checked runtime config declares the binding that generated production Env types omit.
  const runtimeEnv = env as typeof env & {
    readonly OSFO_AGENT_TEST: DurableObjectNamespace<OsfoAgent>;
  };
  const stub = runtimeEnv.OSFO_AGENT_TEST.get(
    runtimeEnv.OSFO_AGENT_TEST.idFromName("integration-runtime-agent"),
  );
  await runInDurableObject(stub, async (_boundAgent, state) => {
    executedReads.length = 0;
    const agent = new IntegrationRuntimeAgent(state, runtimeEnv);
    const agentId = AgentId.make("integration-runtime-agent");
    await agent.initialize({
      agentId,
      initializationId: "integration-runtime-initialization",
      initializedAt: "2026-08-27T12:00:00.000Z",
      routeId: "integration-runtime-route",
      sessionId: "integration-runtime-session",
    });
    await agent.onStart();
    const metadata = integrationTurnMetadata();
    const userMessage: UIMessage = {
      id: "integration-runtime-message",
      metadata: { turnMetadata: metadata },
      parts: [{ text: "Read my Gmail", type: "text" }],
      role: "user",
    };
    await agent.addMessages([userMessage]);
    const config = await agent.beforeTurn({
      continuation: false,
      messages: [{ content: "Read my Gmail", role: "user" }] satisfies Array<ModelMessage>,
      model: new MockLanguageModelV4(),
      system: "",
      tools: compiledIntegrationTools(agent),
    });

    expect(config.activeTools).toEqual([
      "cancelScheduledEmail",
      "gmailFetchThread",
      "gmailSearchEmails",
      "gmailSendEmail",
      "inspectScheduledEmail",
      "scheduleEmail",
    ]);
    expect(config.activeTools).not.toContain("calendarListEvents");
    const gmailRead = config.tools?.gmailFetchThread;
    if (gmailRead?.execute === undefined) throw new Error("Gmail read was not published");
    expect(
      await gmailRead.execute(
        { includeAttachments: false, maximumMessages: 20, threadId: "thread-1" },
        { context: {}, messages: [], toolCallId: "integration-runtime-read" },
      ),
    ).toMatchObject({ evidence: { providerLogIds: ["composio-runtime-log"] } });
    expect(executedReads).toEqual([{ operation: "GMAIL_FETCH_THREAD", userId: runtimeUserId }]);
  });
});

const compiledIntegrationTools = (agent: OsfoAgent): ToolSet => ({
  ...agent.getTools(),
  ...Object.fromEntries(
    [
      "calendarCreateEvent",
      "calendarDeleteEvent",
      "calendarUpdateEvent",
      "driveDeliverArtifact",
      "gmailSendEmail",
      "scheduleEmail",
    ].map((name) => [
      name,
      tool({
        description: "Compiled test Action",
        execute: async () => ({}),
        inputSchema: effectToolSchema(Schema.Struct({})),
        metadata: { cfThinkAction: true },
      }),
    ]),
  ),
});

const integrationTurnMetadata = (): ManagedTurnMetadata =>
  Schema.decodeSync(ManagedTurnMetadata)({
    _tag: "OsfoManagedTurn",
    allowancePeriodId: "integration-runtime-allowance",
    authorityIdentity: {
      _tag: "AuthSession",
      authSessionId: "integration-runtime-auth-session",
      userId: runtimeUserId,
    },
    capabilityCatalogVersion: "governed-capabilities-v1",
    conservativeVendorUsdMicros: 100,
    coreMemoryAuthorization: {
      authority: {
        _tag: "AuthSession",
        authSessionId: "integration-runtime-auth-session",
        expiresAt: "2026-08-27T13:00:00.000Z",
        userId: runtimeUserId,
      },
      deletionAccess: { _tag: "DeletionAccessAvailable" },
      now: "2026-08-27T12:00:00.000Z",
      originatingAuthority: {
        _tag: "AuthSession",
        authSessionId: "integration-runtime-auth-session",
      },
      resourceOwnerUserId: runtimeUserId,
      subscription: { plan: "free", planPolicyVersion: "launch-v1" },
      user: { _tag: "ActiveUser", userId: runtimeUserId },
    },
    maxInputTokens: 32_000,
    maxOutputTokens: 4_096,
    maxRetries: 0,
    maxSteps: 5,
    originatingAuthority: {
      _tag: "AuthSession",
      authSessionId: "integration-runtime-auth-session",
    },
    plan: "free",
    planPolicyVersion: "launch-v1",
    route: "@cf/test/model",
    routeId: "integration-runtime-route",
    sessionId: "integration-runtime-session",
    submissionId: ThinkSubmissionId.make("integration-runtime-submission"),
    targetInputTokens: 18_000,
  });
