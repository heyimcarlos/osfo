/* oxlint-disable effecttsgo/async-function -- Durable Object and AI Tool test boundaries are Promise APIs. */
import { env } from "cloudflare:workers";
import { action } from "@cloudflare/think";
import { expect, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { simulateReadableStream, tool, type ModelMessage, type ToolSet, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Schema } from "effect";

import { AgentId, ChannelLinkId, ThinkSubmissionId, UserId } from "../../domain";
import { ChannelAddress, ChannelAuthorId, ChannelId } from "../../domain/channel-link";
import { ManagedTurnMetadata } from "../../domain/managed-conversation";
import { OsfoAgent } from "./agent";
import { documentBuildStartActionName } from "./action-presentation";
import { effectToolSchema } from "./effect-tool-schema";

const deniedActionIds: Array<string> = [];

class DocumentBuildActionBoundaryAgent extends OsfoAgent {
  readonly #model = documentBuildBoundaryModel();

  override resolveModel() {
    return this.#model;
  }

  override async beforeTurn(context: Parameters<OsfoAgent["beforeTurn"]>[0]) {
    return { ...(await super.beforeTurn(context)), model: this.#model };
  }

  // Keep the regression at the Think Action boundary; turn and usage persistence are covered separately.
  override async onChatResponse() {
    return;
  }

  override async onStepEnd() {
    return;
  }

  override getActions() {
    const actions = super.getActions();
    const startDocumentBuild = actions[documentBuildStartActionName];
    return {
      ...actions,
      [documentBuildStartActionName]: action({
        ...startDocumentBuild.config,
        execute: async (_input, context) => {
          deniedActionIds.push(context.toolCallId);
          throw new Error("Document Build is not available on your current plan.");
        },
      }),
    };
  }
}

it("publishes loadSkill for the verifier's natural Document Build request", async () => {
  // SAFETY: wrangler.runtime.jsonc owns this test-only direct binding to OsfoAgent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The checked runtime config declares the binding that generated production Env types omit.
  const runtimeEnv = env as typeof env & {
    readonly OSFO_AGENT_TEST: DurableObjectNamespace<OsfoAgent>;
  };
  const stub = runtimeEnv.OSFO_AGENT_TEST.get(
    runtimeEnv.OSFO_AGENT_TEST.idFromName("document-build-runtime-agent"),
  );

  await runInDurableObject(stub, async (_boundAgent, state) => {
    const agent = new OsfoAgent(state, runtimeEnv);
    await agent.initialize({
      agentId: AgentId.make("document-build-runtime-agent"),
      initializationId: "document-build-runtime-initialization",
      initializedAt: "2026-08-29T12:00:00.000Z",
      routeId: "document-build-runtime-route",
      sessionId: "document-build-runtime-session",
    });
    await agent.onStart();
    const metadata = documentBuildTurnMetadata();
    const request = "Build a PDF from uploaded File ID web:00000000-0000-4000-8000-000000000289.";
    const userMessage: UIMessage = {
      id: "document-build-runtime-message",
      metadata: { turnMetadata: metadata },
      parts: [{ text: request, type: "text" }],
      role: "user",
    };
    await agent.addMessages([userMessage]);

    const turn = await agent.beforeTurn({
      continuation: false,
      messages: [{ content: request, role: "user" }] satisfies Array<ModelMessage>,
      model: new MockLanguageModelV4(),
      system: "",
      tools: documentBuildTools(agent),
    });

    expect(turn.activeTools).toEqual(["loadSkill"]);
    expect(turn.instructions).toContain("document-build@system-document-build-v1");
    expect(turn.tools?.loadSkill).toBe(agent.getTools().loadSkill);
  });
});

it("executes a launch-v1 Free Document Build Action without pausing for Approval", async () => {
  // SAFETY: wrangler.runtime.jsonc owns this test-only direct binding to OsfoAgent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The checked runtime config declares the binding that generated production Env types omit.
  const runtimeEnv = env as typeof env & {
    readonly OSFO_AGENT_TEST: DurableObjectNamespace<OsfoAgent>;
  };
  const stub = runtimeEnv.OSFO_AGENT_TEST.get(
    runtimeEnv.OSFO_AGENT_TEST.idFromName("document-build-action-boundary-agent"),
  );

  await runInDurableObject(stub, async (_boundAgent, state) => {
    deniedActionIds.length = 0;
    const agent = new DocumentBuildActionBoundaryAgent(state, runtimeEnv);
    await agent.initialize({
      agentId: AgentId.make("document-build-action-boundary-agent"),
      initializationId: "document-build-action-boundary-initialization",
      initializedAt: "2026-08-29T12:00:00.000Z",
      routeId: "document-build-action-boundary-route",
      sessionId: "document-build-action-boundary-session",
    });
    await agent.onStart();
    const metadata = documentBuildTurnMetadata();
    const request = "Build a PDF from uploaded File ID web:00000000-0000-4000-8000-000000000289.";
    const result = await agent.runTurn({
      input: {
        id: "document-build-action-boundary-message",
        metadata: { turnMetadata: metadata },
        parts: [{ text: request, type: "text" }],
        role: "user",
      },
      mode: "wait",
    });

    expect(deniedActionIds).toEqual(["document-build-runtime-start"]);
    expect(await agent.pendingApprovals()).toEqual([]);
    expect(result.status).toBe("completed");
    const messages = await agent.getMessages();
    const assistant = messages[messages.length - 1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.parts[assistant.parts.length - 1]).toEqual({
      state: "done",
      text: "Document Build is not available on your current plan.",
      type: "text",
    });
  });
});

const documentBuildTools = (agent: OsfoAgent): ToolSet => ({
  ...agent.getTools(),
  startDocumentBuild: tool({
    description: "Compiled test Document Build Action",
    execute: async () => ({}),
    inputSchema: effectToolSchema(Schema.Struct({})),
    metadata: { cfThinkAction: true },
  }),
});

const documentBuildBoundaryModel = (): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    doStream: [
      toolCallResponse(
        "document-build-runtime-load-skill",
        "loadSkill",
        JSON.stringify({
          skillId: "document-build",
          skillVersion: "system-document-build-v1",
        }),
      ),
      toolCallResponse(
        "document-build-runtime-start",
        documentBuildStartActionName,
        JSON.stringify({
          fileIds: ["web:00000000-0000-4000-8000-000000000289"],
          format: "pdf",
        }),
      ),
      {
        stream: simulateReadableStream({
          chunks: [
            { id: "document-build-denial", type: "text-start" },
            {
              delta: "Document Build is not available on your current plan.",
              id: "document-build-denial",
              type: "text-delta",
            },
            { id: "document-build-denial", type: "text-end" },
            finishPart("stop"),
          ],
        }),
      },
    ],
  });

const toolCallResponse = (toolCallId: string, toolName: string, input: string) => ({
  stream: simulateReadableStream({
    chunks: [{ input, toolCallId, toolName, type: "tool-call" as const }, finishPart("tool-calls")],
  }),
});

const finishPart = (unified: "stop" | "tool-calls") => ({
  finishReason: { raw: undefined, unified },
  type: "finish" as const,
  usage: {
    inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
    outputTokens: { reasoning: undefined, text: 1, total: 1 },
  },
});

const documentBuildTurnMetadata = (): ManagedTurnMetadata =>
  Schema.decodeSync(ManagedTurnMetadata)({
    _tag: "OsfoManagedTurn",
    allowancePeriodId: "document-build-runtime-allowance",
    authorityIdentity: {
      _tag: "ChannelLink",
      address: ChannelAddress.make({
        authorId: ChannelAuthorId.make("document-build-runtime-author"),
        channelId: ChannelId.make("document-build-runtime-channel"),
      }),
      channelLinkId: ChannelLinkId.make("document-build-runtime-link"),
      userId: UserId.make("document-build-runtime-user"),
    },
    capabilityCatalogVersion: "governed-capabilities-v1",
    conservativeVendorUsdMicros: 100,
    coreMemoryAuthorization: {
      authority: {
        _tag: "ChannelLink",
        address: ChannelAddress.make({
          authorId: ChannelAuthorId.make("document-build-runtime-author"),
          channelId: ChannelId.make("document-build-runtime-channel"),
        }),
        channelLinkId: ChannelLinkId.make("document-build-runtime-link"),
        userId: "document-build-runtime-user",
      },
      deletionAccess: { _tag: "DeletionAccessAvailable" },
      now: "2026-08-29T12:00:00.000Z",
      originatingAuthority: {
        _tag: "ChannelLink",
        channelLinkId: "document-build-runtime-link",
      },
      resourceOwnerUserId: "document-build-runtime-user",
      subscription: { plan: "free", planPolicyVersion: "launch-v1" },
      user: { _tag: "ActiveUser", userId: "document-build-runtime-user" },
    },
    maxInputTokens: 32_000,
    maxOutputTokens: 4_096,
    maxRetries: 0,
    maxSteps: 5,
    originatingAuthority: {
      _tag: "ChannelLink",
      channelLinkId: "document-build-runtime-link",
    },
    plan: "free",
    planPolicyVersion: "launch-v1",
    route: "@cf/test/model",
    routeId: "document-build-runtime-route",
    sessionId: "document-build-runtime-session",
    submissionId: ThinkSubmissionId.make("document-build-runtime-submission"),
    targetInputTokens: 18_000,
  });
