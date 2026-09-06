/* oxlint-disable effecttsgo/async-function -- Durable Object and AI Tool test boundaries are Promise APIs. */
import { env } from "cloudflare:workers";
import { action } from "@cloudflare/think";
import { expect, it } from "@effect/vitest";
import { beforeEach, afterEach, vi } from "vitest";
import { IncidentControlsPostgres } from "../../integrations/postgres/incident-controls";
import { IncidentControls } from "../../services/incident-controls";
import { Db } from "../../db";
import { runInDurableObject } from "cloudflare:test";
import { simulateReadableStream, tool, type ModelMessage, type ToolSet, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Deferred, Effect, Layer, Schema } from "effect";

import { AgentId, ChannelLinkId, ThinkSubmissionId, UserId } from "../../domain";
import { ChannelAddress, ChannelAuthorId, ChannelId } from "../../domain/channel-link";
import { ManagedTurnMetadata } from "../../domain/managed-conversation";
import { OsfoAgent } from "./agent";
import { documentBuildStartActionName } from "./action-presentation";
import { runDocumentBuildStartAction } from "./document-build-action";
import { effectToolSchema } from "./effect-tool-schema";

// This focused runtime has no PostgreSQL server; the authority adapter is supplied explicitly.
beforeEach(() => {
  vi.spyOn(IncidentControlsPostgres, "check").mockReturnValue(Effect.void);
});
afterEach(() => vi.restoreAllMocks());

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
        execute: (_input, context) => {
          deniedActionIds.push(context.toolCallId);
          return runDocumentBuildStartAction(
            Effect.fail({
              _tag: "Denied" as const,
              reason: "missingEntitlement" as const,
              resetAt: null,
            }),
          );
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

it.each([
  "Fill this PDF from File ID web:00000000-0000-4000-8000-000000000289.",
  "Fill this application using my details.",
  "Use unit 12 and leave the signature blank.",
])("retains PDF inspection for ordinary requests and follow-ups: %s", async (request) => {
  // SAFETY: wrangler.runtime.jsonc owns this test-only direct binding to OsfoAgent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The checked runtime config declares the binding that generated production Env types omit.
  const runtimeEnv = env as typeof env & {
    readonly OSFO_AGENT_TEST: DurableObjectNamespace<OsfoAgent>;
  };
  const stub = runtimeEnv.OSFO_AGENT_TEST.get(
    runtimeEnv.OSFO_AGENT_TEST.idFromName("pdf-form-runtime-agent"),
  );

  await runInDurableObject(stub, async (_boundAgent, state) => {
    const agent = new OsfoAgent(state, runtimeEnv);
    await agent.initialize({
      agentId: AgentId.make("pdf-form-runtime-agent"),
      initializationId: "document-build-runtime-initialization",
      initializedAt: "2026-08-29T12:00:00.000Z",
      routeId: "document-build-runtime-route",
      sessionId: "document-build-runtime-session",
    });
    await agent.onStart();
    const metadata = documentBuildTurnMetadata();
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
      tools: {
        ...agent.getTools(),
        ...Object.fromEntries(
          ["inspectPdfForm", "generateDocument"].map((name) => [
            name,
            tool({
              description: "Compiled PDF Action",
              inputSchema: effectToolSchema(Schema.Struct({})),
              metadata: { cfThinkAction: true },
            }),
          ]),
        ),
      },
    });

    expect(turn.activeTools).toEqual(["loadSkill"]);
    expect(turn.instructions).toContain("document-production@system-document-production-v1");
    expect(turn.tools?.inspectPdfForm).toBeDefined();
    expect(agent.getActions().inspectPdfForm.config.description).toContain("PDF");
    expect(turn.tools?.loadSkill).toBe(agent.getTools().loadSkill);
  });
});

it("publishes loadSkill for the verifier's exact Document Build status request", async () => {
  // SAFETY: wrangler.runtime.jsonc owns this test-only direct binding to OsfoAgent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The checked runtime config declares the binding that generated production Env types omit.
  const runtimeEnv = env as typeof env & {
    readonly OSFO_AGENT_TEST: DurableObjectNamespace<OsfoAgent>;
  };
  const stub = runtimeEnv.OSFO_AGENT_TEST.get(
    runtimeEnv.OSFO_AGENT_TEST.idFromName("document-build-status-runtime-agent"),
  );

  await runInDurableObject(stub, async (_boundAgent, state) => {
    const agent = new OsfoAgent(state, runtimeEnv);
    await agent.initialize({
      agentId: AgentId.make("document-build-status-runtime-agent"),
      initializationId: "document-build-status-runtime-initialization",
      initializedAt: "2026-08-29T12:00:00.000Z",
      routeId: "document-build-status-runtime-route",
      sessionId: "document-build-status-runtime-session",
    });
    await agent.onStart();
    const metadata = documentBuildTurnMetadata();
    const request = "Inspect Document Build document-build:verification-status-00000001 status.";
    const userMessage: UIMessage = {
      id: "document-build-status-runtime-message",
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

it("returns a ready stored source across the Agent RPC boundary", async () => {
  // SAFETY: wrangler.runtime.jsonc owns this test-only direct binding to OsfoAgent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The checked runtime config declares the binding that generated production Env types omit.
  const runtimeEnv = env as typeof env & {
    readonly OSFO_AGENT_TEST: DurableObjectNamespace<OsfoAgent>;
  };
  const agentId = AgentId.make("document-build-file-resolution-agent");
  const userId = UserId.make("document-build-file-resolution-user");
  const fileId = "web:00000000-0000-4000-8000-000000000290";
  const stub = runtimeEnv.OSFO_AGENT_TEST.get(runtimeEnv.OSFO_AGENT_TEST.idFromName(agentId));

  await runInDurableObject(stub, async (agent, state) => {
    await agent.initialize({
      agentId,
      initializationId: "document-build-file-resolution-initialization",
      initializedAt: "2026-08-29T12:00:00.000Z",
      routeId: "document-build-file-resolution-route",
      sessionId: "document-build-file-resolution-session",
    });
    await agent.onStart();
    state.storage.sql.exec(
      `INSERT INTO osfo_files (
         accepted_at, allowance_period_id, byte_length, deleted_at, file_id,
         file_name, media_type, normalization_claimed_at, normalization_error,
         normalized_text, object_key, provenance_json, sha256, state, upload_id, user_id
       ) VALUES (?, ?, 12, NULL, ?, ?, 'text/plain', NULL, NULL, ?, ?, '{}', ?, 'ready', ?, ?)`,
      "2026-08-29T12:00:00.000Z",
      "document-build-file-resolution-period",
      fileId,
      "Source.txt",
      "source text",
      "users/document-build-file-resolution/source",
      `sha256:${"a".repeat(64)}`,
      "document-build-file-resolution-upload",
      userId,
    );
  });

  await expect(
    stub.resolveDocumentBuildFiles({ agentId, fileIds: [fileId], userId }),
  ).resolves.toEqual({
    _tag: "Resolved",
    files: [
      {
        byteLength: 12n,
        fileId,
        fileName: "Source.txt",
        mediaType: "text/plain",
        normalizedText: "source text",
        sha256: `sha256:${"a".repeat(64)}`,
      },
    ],
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
    expect(assistant?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          output: {
            _tag: "Denied",
            reason: "missingEntitlement",
            resetAt: null,
          },
          state: "output-available",
          toolCallId: "document-build-runtime-start",
          toolName: documentBuildStartActionName,
        }),
      ]),
    );
    expect(assistant?.parts[assistant.parts.length - 1]).toEqual({
      state: "done",
      text: "Document Build is not available on your current plan.",
      type: "text",
    });
  });
});

it.each(["paused", "unavailable", "provider-error"] as const)(
  "preserves model admission evidence when client streaming fails: %s",
  async (outcome) => {
    // SAFETY: the runtime config declares this direct test binding.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The checked runtime config declares this test-only binding.
    const runtimeEnv = env as typeof env & {
      readonly OSFO_AGENT_TEST: DurableObjectNamespace<OsfoAgent>;
    };
    const stub = runtimeEnv.OSFO_AGENT_TEST.get(
      runtimeEnv.OSFO_AGENT_TEST.idFromName(`incident-model-${outcome}`),
    );
    await runInDurableObject(stub, async (_boundAgent, state) => {
      const admissionObserved = Deferred.makeUnsafe<void>();
      const dispatch = vi.fn<() => Promise<never>>(async () => {
        await Effect.runPromise(Deferred.succeed(admissionObserved, undefined));
        throw new Error("Provider failed after dispatch");
      });
      const model = new MockLanguageModelV4({ doStream: dispatch });
      class IncidentModelAgent extends OsfoAgent {
        override resolveModel() {
          return model;
        }
        override async onChatResponse() {
          return;
        }
      }
      // Retain real SQLite billing evidence without opening a PostgreSQL connection in this focused runtime.
      vi.spyOn(Db, "layer").mockReturnValue(
        Layer.succeed(Db.Service, {
          database: Effect.die(new Error("Runtime fixture PostgreSQL dispatch is unavailable")),
        }),
      );
      const agent = new IncidentModelAgent(state, runtimeEnv);
      await agent.initialize({
        agentId: AgentId.make("document-build-action-boundary-agent"),
        initializationId: `incident-model-${outcome}`,
        initializedAt: "2026-08-29T12:00:00.000Z",
        routeId: "document-build-action-boundary-route",
        sessionId: "document-build-action-boundary-session",
      });
      await agent.onStart();
      const errorHook = vi.spyOn(agent, "onChatError");
      vi.mocked(IncidentControlsPostgres.check).mockReturnValue(
        outcome === "paused"
          ? Effect.fail(new IncidentControls.Paused({ control: "newCostlyWork" })).pipe(
              Effect.ensuring(Deferred.succeed(admissionObserved, undefined)),
            )
          : outcome === "unavailable"
            ? Effect.fail(
                new IncidentControls.Unavailable({
                  cause: new Error("Control database unavailable"),
                }),
              ).pipe(Effect.ensuring(Deferred.succeed(admissionObserved, undefined)))
            : Effect.void,
      );
      await agent.chat(
        "Build a PDF from my uploaded file.",
        {
          onStart: () => undefined,
          onEvent: async () => {
            await Effect.runPromise(Deferred.await(admissionObserved));
            throw new Error("Client stream delivery failed");
          },
          onDone: () => undefined,
          onError: () => undefined,
        },
        { metadata: { ...documentBuildTurnMetadata() } },
      );
      expect(errorHook).toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledTimes(outcome === "provider-error" ? 1 : 0);
      const evidence = state.storage.sql
        .exec("SELECT * FROM osfo_model_call_usage_evidence")
        .toArray();
      expect(evidence).toHaveLength(outcome === "provider-error" ? 1 : 0);
    });
  },
);

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
