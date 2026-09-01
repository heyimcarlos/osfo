/* oxlint-disable vitest/no-standalone-expect, eslint/no-underscore-dangle -- Assertions execute inside Effects and provider outcomes use _tag. */
/* oxlint-disable effecttsgo/global-date-in-effect, effecttsgo/global-fetch-in-effect -- This Node boundary test owns fixed evidence time and emulator ledger I/O. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { CapabilityCatalogVersion, UserId } from "../../domain";
import { launchModelAccessPolicy } from "../../domain/model-access-policy";
import { Capabilities } from "../../services/capabilities";
import { ResearchCollector } from "../../services/research-collector";
import { ResearchReport } from "../../services/research-report";
import { ResearchSynthesis } from "../../services/research-synthesis";
import { startProviderEmulator } from "../../../test/emulators/provider-emulator";
import { ResearchVerificationProvider } from "./research-verification-provider";

const augmentProviderEvidence = (recentConversation: string, currentInstruction: string) =>
  `## Provider profile evidence\nNo provider profile facts.\n\n## Recent unindexed conversation source evidence\n${recentConversation}\n\n${currentInstruction}`;

it.effect(
  "runs deterministic discovery, page retrieval, and cited synthesis through the ledger",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(startProviderEmulator),
      (emulator) =>
        Effect.gen(function* () {
          const provider = ResearchVerificationProvider.make({
            _tag: "LocalVerification",
            baseURL: emulator.origin,
          });
          const discovered = yield* provider.discover("durable workflow verification", 10);
          expect(discovered.results).toHaveLength(1);
          expect(discovered.results[0]?.url).toBe(
            "https://research.verify.osfo.test/durable-workflows",
          );
          const page = yield* provider.fetchPage({ url: discovered.results[0]?.url ?? "" });
          expect(page.content).toContain("canonical public source evidence");
          const source = ResearchCollector.ManifestSource.make({
            contentDigest: ResearchReport.InputDigest.make("a".repeat(64)),
            contentKey: "users/verifier/research-report/sources/source.json",
            fetchedAt: new Date("2026-08-28T12:00:00.000Z"),
            sourceId: "S1",
            title: page.title,
            url: page.finalUrl,
          });
          const synthesis = yield* provider.synthesize.generate({
            modelRoute: launchModelAccessPolicy.plans.free.route,
            operationId: ResearchSynthesis.OperationId.make("local-verification-synthesis"),
            sources: [{ content: page.content, source }],
            topic: "durable workflow verification",
          });
          expect(synthesis._tag).toBe("Completed");
          if (synthesis._tag !== "Completed") return;
          expect(synthesis.companyCost.usdMicros).toBe(0n);
          expect(synthesis.result).toMatchObject({
            title: "Deterministic Research Report verification",
          });
          const ledger = yield* Effect.promise(() =>
            fetch(`${emulator.origin}/_test/research/ledger`).then((response) => response.json()),
          );
          expect(ledger).toEqual([
            { kind: "discover", operationId: null, subject: "durable workflow verification" },
            {
              kind: "page",
              operationId: null,
              subject: "https://research.verify.osfo.test/durable-workflows",
            },
            {
              kind: "synthesize",
              operationId: "local-verification-synthesis",
              subject: "durable workflow verification",
            },
          ]);
        }),
      (emulator) => Effect.promise(emulator.close),
    ),
);

it.effect("serializes the Workers AI request shape through the local Agent boundary", () =>
  Effect.acquireUseRelease(
    Effect.promise(startProviderEmulator),
    (emulator) =>
      Effect.gen(function* () {
        const binding = ResearchVerificationProvider.makeAiBinding({
          _tag: "LocalVerification",
          baseURL: emulator.origin,
        });
        const response = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            max_tokens: undefined,
            messages: [{ content: "Connect this Telegram chat", role: "user" }],
            stream: true,
            temperature: undefined,
            tools: [
              {
                function: {
                  description: "Present a Telegram channel-link invitation",
                  name: "present_link",
                  parameters: { properties: {}, type: "object" },
                },
                type: "function",
              },
            ],
            top_p: undefined,
          }),
        );
        expect(response).toMatchObject({
          finish_reason: "tool_calls",
          tool_calls: [{ name: "present_link" }],
        });
        const workflowId = `research:${"a".repeat(64)}`;
        const inspectResponse = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            max_tokens: undefined,
            messages: [{ content: `Inspect Research Report ${workflowId} status.`, role: "user" }],
            stream: true,
            temperature: undefined,
            tools: [
              {
                function: {
                  description: "Start a Research Report",
                  name: "startResearchReport",
                  parameters: { properties: {}, type: "object" },
                },
                type: "function",
              },
              {
                function: {
                  description: "Inspect a Research Report",
                  name: "inspectResearchReport",
                  parameters: { properties: {}, type: "object" },
                },
                type: "function",
              },
              {
                function: {
                  description: "Cancel a Research Report",
                  name: "cancelResearchReport",
                  parameters: { properties: {}, type: "object" },
                },
                type: "function",
              },
            ],
            top_p: undefined,
          }),
        );
        expect(inspectResponse).toMatchObject({
          finish_reason: "tool_calls",
          tool_calls: [{ arguments: { workflowId }, name: "inspectResearchReport" }],
        });
        const inspectCompletion = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            max_tokens: undefined,
            messages: [
              { content: `Inspect Research Report ${workflowId} status.`, role: "user" },
              {
                // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- This trusted Workers AI fixture mirrors the provider's tool-result wire text.
                content: JSON.stringify({ state: "success", workflowId }),
                name: "inspectResearchReport",
                role: "tool",
                tool_call_id: "verification-inspectResearchReport",
              },
            ],
            stream: true,
            temperature: undefined,
            tools: [
              {
                function: {
                  description: "Start a Research Report",
                  name: "startResearchReport",
                  parameters: { properties: {}, type: "object" },
                },
                type: "function",
              },
              {
                function: {
                  description: "Inspect a Research Report",
                  name: "inspectResearchReport",
                  parameters: { properties: {}, type: "object" },
                },
                type: "function",
              },
              {
                function: {
                  description: "Cancel a Research Report",
                  name: "cancelResearchReport",
                  parameters: { properties: {}, type: "object" },
                },
                type: "function",
              },
            ],
            top_p: undefined,
          }),
        );
        expect(inspectCompletion).toMatchObject({ finish_reason: "stop" });
        const cancelResponse = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            max_tokens: undefined,
            messages: [{ content: `Cancel Research Report ${workflowId}.`, role: "user" }],
            stream: true,
            temperature: undefined,
            tools: [
              {
                function: {
                  description: "Start a Research Report",
                  name: "startResearchReport",
                  parameters: { properties: {}, type: "object" },
                },
                type: "function",
              },
              {
                function: {
                  description: "Inspect a Research Report",
                  name: "inspectResearchReport",
                  parameters: { properties: {}, type: "object" },
                },
                type: "function",
              },
              {
                function: {
                  description: "Cancel a Research Report",
                  name: "cancelResearchReport",
                  parameters: { properties: {}, type: "object" },
                },
                type: "function",
              },
            ],
            top_p: undefined,
          }),
        );
        expect(cancelResponse).toMatchObject({
          finish_reason: "tool_calls",
          tool_calls: [{ arguments: { workflowId }, name: "cancelResearchReport" }],
        });
        const ledger = yield* Effect.promise(() =>
          fetch(`${emulator.origin}/_test/research/ledger`).then((result) => result.json()),
        );
        expect(ledger).toEqual([
          {
            kind: "agent",
            operationId: null,
            subject: expect.stringContaining("Connect this Telegram chat"),
          },
          {
            kind: "agent",
            operationId: null,
            subject: expect.stringContaining(`Inspect Research Report ${workflowId} status.`),
          },
          {
            kind: "agent",
            operationId: null,
            subject: expect.stringContaining('"name":"inspectResearchReport"'),
          },
          {
            kind: "agent",
            operationId: null,
            subject: expect.stringContaining(`Cancel Research Report ${workflowId}.`),
          },
        ]);
      }),
    (emulator) => Effect.promise(emulator.close),
  ),
);

it.effect("writes and recalls a corrected run-owned Core Memory fact without hidden state", () =>
  Effect.acquireUseRelease(
    Effect.promise(startProviderEmulator),
    (emulator) =>
      Effect.gen(function* () {
        const binding = ResearchVerificationProvider.makeAiBinding({
          _tag: "LocalVerification",
          baseURL: emulator.origin,
        });
        const setContextTool = {
          function: {
            description: "Write Core Memory",
            name: "set_context",
            parameters: { properties: {}, type: "object" },
          },
          type: "function" as const,
        };
        const sessionRecallTool = {
          function: {
            description: "Search historical Sessions",
            name: "sessionRecall",
            parameters: { properties: {}, type: "object" },
          },
          type: "function" as const,
        };
        const superseded = "spruce-soda-verify-memory-provider";
        const corrected = "cedar-cocoa-verify-memory-provider";

        const initial = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [
              {
                content: `Remember that my run-owned verification drink is ${superseded}.`,
                role: "user",
              },
            ],
            tools: [setContextTool],
          }),
        );
        expect(initial).toMatchObject({
          finish_reason: "tool_calls",
          tool_calls: [
            {
              arguments: {
                action: "append",
                block: "userContext",
                content: `My run-owned verification drink is ${superseded}.`,
              },
              name: "set_context",
            },
          ],
        });

        const correction = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [
              {
                content: `Correction: remember that my run-owned verification drink is ${corrected}, not ${superseded}.`,
                role: "user",
              },
            ],
            tools: [setContextTool],
          }),
        );
        expect(correction).toMatchObject({
          finish_reason: "tool_calls",
          tool_calls: [
            {
              arguments: {
                action: "replace",
                block: "userContext",
                content: `My run-owned verification drink is ${corrected}.`,
              },
              name: "set_context",
            },
          ],
        });
        expect(correction).not.toMatchObject({
          tool_calls: [
            {
              arguments: { content: expect.stringContaining(superseded) },
              name: "set_context",
            },
          ],
        });

        const misplacedCoreMemory = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [
              {
                content: `Rolled Session summary\nMy run-owned verification drink is ${corrected}.`,
                role: "system",
              },
              { content: "What is my run-owned verification drink?", role: "user" },
            ],
            tools: [sessionRecallTool],
          }),
        );
        expect(misplacedCoreMemory).toMatchObject({
          finish_reason: "stop",
          response: "Committed Osfo result: What is my run-owned verification drink?",
        });
        expect(misplacedCoreMemory).not.toHaveProperty("tool_calls");

        const copiedAssistantHistory = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [
              {
                content: `${"═".repeat(46)}\nUSER CONTEXT (Durable Agent-owned User facts) [writable]\n${"═".repeat(46)}\nMy run-owned verification drink is ${corrected}.`,
                role: "system",
              },
              {
                content: "Rolled Session summary: I corrected your run-owned verification drink.",
                role: "system",
              },
              { content: "What is my run-owned verification drink?", role: "user" },
            ],
            tools: [sessionRecallTool],
          }),
        );
        expect(copiedAssistantHistory).toMatchObject({
          finish_reason: "stop",
          response: `Your run-owned verification drink is ${corrected}.`,
        });

        const profile = yield* Effect.promise(() =>
          fetch(`${emulator.origin}/v4/profile`, { body: "{}", method: "POST" }).then((response) =>
            response.json(),
          ),
        );
        expect(profile).toEqual({
          profile: { dynamic: [], static: [] },
          searchResults: { results: [], timing: 0, total: 0 },
        });
        const search = yield* Effect.promise(() =>
          fetch(`${emulator.origin}/v4/search`, { body: "{}", method: "POST" }).then((response) =>
            response.json(),
          ),
        );
        expect(search).toEqual({ results: [], timing: 0, total: 0 });

        const recalled = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [
              {
                content: `${"═".repeat(46)}\nUSER CONTEXT (Durable Agent-owned User facts) [writable]\n${"═".repeat(46)}\nMy run-owned verification drink is ${corrected}.`,
                role: "system",
              },
              { content: "What is my run-owned verification drink?", role: "user" },
            ],
            tools: [sessionRecallTool],
          }),
        );
        expect(recalled).toMatchObject({
          finish_reason: "stop",
          response: `Your run-owned verification drink is ${corrected}.`,
        });
        expect(recalled).not.toHaveProperty("tool_calls");

        const withoutCoreMemory = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [{ content: "What is my run-owned verification drink?", role: "user" }],
            tools: [sessionRecallTool],
          }),
        );
        expect(withoutCoreMemory).toMatchObject({
          finish_reason: "stop",
          response: "Committed Osfo result: What is my run-owned verification drink?",
        });
        expect(withoutCoreMemory).not.toHaveProperty("tool_calls");
        expect(withoutCoreMemory.response).not.toContain(corrected);
        expect(withoutCoreMemory.response).not.toContain(superseded);

        const ledger = yield* Effect.promise(() =>
          fetch(`${emulator.origin}/_test/research/ledger`).then((response) => response.json()),
        );
        expect(ledger).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              arguments: {
                action: "append",
                block: "userContext",
                content: `My run-owned verification drink is ${superseded}.`,
              },
              kind: "tool-selection",
              selectedTool: "set_context",
            }),
            expect.objectContaining({
              arguments: {
                action: "replace",
                block: "userContext",
                content: `My run-owned verification drink is ${corrected}.`,
              },
              kind: "tool-selection",
              selectedTool: "set_context",
            }),
            {
              kind: "agent",
              latestAgentSequence: 8,
              operationId: null,
              recallRequest: {
                copiedHistoricalTurnCount: 0,
                correctedOutsideUserContextCount: 0,
                nonSystemMessages: [
                  { content: "What is my run-owned verification drink?", role: "user" },
                ],
                requestMessageCount: 2,
                supersededCount: 0,
                systemMessageCount: 1,
                userContextSections: [`My run-owned verification drink is ${corrected}.`],
              },
              sequence: 7,
              subject: expect.stringContaining("What is my run-owned verification drink?"),
            },
            expect.objectContaining({
              kind: "agent",
              recallRequest: expect.objectContaining({ copiedHistoricalTurnCount: 1 }),
              sequence: 4,
            }),
          ]),
        );
        expect(ledger).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ selectedTool: "sessionRecall" })]),
        );
        const supermemoryLedger = yield* Effect.promise(() =>
          fetch(`${emulator.origin}/_test/supermemory/ledger`).then((response) => response.json()),
        );
        expect(supermemoryLedger).toEqual([
          {
            dynamicProfileCount: 0,
            method: "POST",
            path: "/v4/profile",
            searchResultCount: 0,
            sequence: 5,
            staticProfileCount: 0,
          },
          { method: "POST", path: "/v4/search", searchResultCount: 0, sequence: 6 },
        ]);
      }),
    (emulator) => Effect.promise(emulator.close),
  ),
);

it.effect(
  "selects the augmented current Core Memory instruction without searching prior turns",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(startProviderEmulator),
      (emulator) =>
        Effect.gen(function* () {
          const binding = ResearchVerificationProvider.makeAiBinding({
            _tag: "LocalVerification",
            baseURL: emulator.origin,
          });
          const setContextTool = {
            function: {
              description: "Write Core Memory",
              name: "set_context",
              parameters: { properties: {}, type: "object" },
            },
            type: "function" as const,
          };
          const sessionRecallTool = {
            function: {
              description: "Search historical Sessions",
              name: "sessionRecall",
              parameters: { properties: {}, type: "object" },
            },
            type: "function" as const,
          };
          const suffix = "verify-memory-augmented-provider";
          const ordinaryPrompt = `Give me a normal run-owned reply for ${suffix}.`;
          const ordinaryReply = `Committed Osfo result: ${ordinaryPrompt}`;
          const superseded = `spruce-soda-${suffix}`;
          const corrected = `cedar-cocoa-${suffix}`;
          const initialPrompt = `Remember that my run-owned verification drink is ${superseded}.`;
          const correctionPrompt = `Correction: remember that my run-owned verification drink is ${corrected}, not ${superseded}.`;
          const recallPrompt = "What is my run-owned verification drink?";
          const ordinary = yield* Effect.promise(() =>
            binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
              messages: [
                {
                  content: augmentProviderEvidence(
                    "No recent conversation evidence.",
                    ordinaryPrompt,
                  ),
                  role: "user",
                },
              ],
            }),
          );
          expect(ordinary).toMatchObject({ finish_reason: "stop", response: ordinaryReply });

          const initial = yield* Effect.promise(() =>
            binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
              messages: [
                { content: ordinaryPrompt, role: "user" },
                { content: ordinaryReply, role: "assistant" },
                {
                  content: augmentProviderEvidence(
                    `User: ${ordinaryPrompt}\nAssistant: ${ordinaryReply}`,
                    initialPrompt,
                  ),
                  role: "user",
                },
              ],
              tools: [setContextTool],
            }),
          );
          expect(initial).toMatchObject({
            finish_reason: "tool_calls",
            tool_calls: [
              {
                arguments: {
                  action: "append",
                  block: "userContext",
                  content: `My run-owned verification drink is ${superseded}.`,
                },
                name: "set_context",
              },
            ],
          });

          const correctionMessages = [
            { content: ordinaryPrompt, role: "user" as const },
            { content: ordinaryReply, role: "assistant" as const },
            { content: initialPrompt, role: "user" as const },
            {
              content: "I remembered your run-owned verification drink.",
              role: "assistant" as const,
            },
            {
              content: augmentProviderEvidence(
                `User: ${initialPrompt}\nAssistant: I remembered your run-owned verification drink.`,
                correctionPrompt,
              ),
              role: "user" as const,
            },
          ];
          const correction = yield* Effect.promise(() =>
            binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
              messages: correctionMessages,
              tools: [setContextTool],
            }),
          );
          expect(correction).toMatchObject({
            finish_reason: "tool_calls",
            tool_calls: [
              {
                arguments: {
                  action: "replace",
                  block: "userContext",
                  content: `My run-owned verification drink is ${corrected}.`,
                },
                name: "set_context",
              },
            ],
          });

          const correctionFollowup = yield* Effect.promise(() =>
            binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
              messages: [
                ...correctionMessages,
                {
                  content: "Written to userContext.",
                  name: "set_context",
                  role: "tool",
                  tool_call_id: "verification-set_context-correction",
                },
              ],
              tools: [setContextTool],
            }),
          );
          expect(correctionFollowup).toMatchObject({
            finish_reason: "stop",
            response: "I corrected your run-owned verification drink.",
          });

          const staleCorrectionFollowup = yield* Effect.promise(() =>
            binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
              messages: [
                ...correctionMessages,
                {
                  content: "Written to userContext.",
                  name: "set_context",
                  role: "tool",
                  tool_call_id: "verification-set_context-initial",
                },
              ],
              tools: [setContextTool],
            }),
          );
          expect(staleCorrectionFollowup).toMatchObject({
            finish_reason: "stop",
            response: "Committed Osfo result: Written to userContext.",
          });
          expect(staleCorrectionFollowup.response).not.toContain("corrected");

          const recalled = yield* Effect.promise(() =>
            binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
              messages: [
                {
                  content: `${"═".repeat(46)}\nUSER CONTEXT (Durable Agent-owned User facts) [writable]\n${"═".repeat(46)}\nMy run-owned verification drink is ${corrected}.`,
                  role: "system",
                },
                {
                  content: augmentProviderEvidence(
                    `User: ${initialPrompt}\nAssistant: I remembered your run-owned verification drink.\nUser: ${correctionPrompt}\nAssistant: I corrected your run-owned verification drink.`,
                    recallPrompt,
                  ),
                  role: "user",
                },
              ],
              tools: [sessionRecallTool],
            }),
          );
          expect(recalled).toMatchObject({
            finish_reason: "stop",
            response: `Your run-owned verification drink is ${corrected}.`,
          });
          expect(recalled).not.toHaveProperty("tool_calls");

          const ledger = yield* Effect.promise(() =>
            fetch(`${emulator.origin}/_test/research/ledger`).then((response) => response.json()),
          );
          expect(ledger).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                kind: "agent",
                recallRequest: {
                  copiedHistoricalTurnCount: 0,
                  correctedOutsideUserContextCount: 0,
                  nonSystemMessages: [{ content: recallPrompt, role: "user" }],
                  requestMessageCount: 2,
                  supersededCount: 0,
                  systemMessageCount: 1,
                  userContextSections: [`My run-owned verification drink is ${corrected}.`],
                },
              }),
            ]),
          );
        }),
      (emulator) => Effect.promise(emulator.close),
    ),
);

it.effect("projects the strict Scheduled Email request into the local model selector", () =>
  Effect.acquireUseRelease(
    Effect.promise(startProviderEmulator),
    (emulator) =>
      Effect.gen(function* () {
        const request =
          "Schedule this exact Gmail message: recipient=verify@example.test; subject=Scheduled Email verification; body=Run-owned Scheduled Email verification; sendAt=2026-08-29T00:25:19.574Z";
        const availableToolNames = [
          "cancelScheduledEmail",
          "gmailFetchThread",
          "gmailSearchEmails",
          "gmailSendEmail",
          "inspectScheduledEmail",
          "loadSkill",
          "scheduleEmail",
        ] as const;
        const capabilities = Capabilities.make();
        const index = yield* capabilities.eligibleIndex({
          availableIntegrationToolkits: ["gmail"],
          availableRequirements: ["composio", "personal-agent"],
          availableToolNames,
          catalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
          declaredRequirements: [],
          origin: "channelLink",
          personalSkills: [],
          plan: "adventurer",
          taskDescription: request,
          taskKinds: Capabilities.taskKindsFor(request),
          userId: UserId.make("scheduled-email-local-verifier"),
        });
        const toolNames = capabilities.assembleToolBundle({
          availableToolNames,
          index,
          loadedSkills: [],
        }).activeToolNames;
        expect(toolNames).toContain("scheduleEmail");

        const binding = ResearchVerificationProvider.makeAiBinding({
          _tag: "LocalVerification",
          baseURL: emulator.origin,
        });
        const response = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [{ content: request, role: "user" }],
            tools: toolNames.map((name) => ({
              function: { name, parameters: { properties: {}, type: "object" } },
              type: "function" as const,
            })),
          }),
        );
        expect(response).toMatchObject({
          finish_reason: "tool_calls",
          tool_calls: [
            {
              arguments: {
                body: "Run-owned Scheduled Email verification",
                gmailResource: "primary",
                recipients: ["verify@example.test"],
                scheduledAt: "2026-08-29T00:25:19.574Z",
                subject: "Scheduled Email verification",
              },
              name: "scheduleEmail",
            },
          ],
        });
      }),
    (emulator) => Effect.promise(emulator.close),
  ),
);

it.effect("loads Document Build before selecting and safely presenting its denied action", () =>
  Effect.acquireUseRelease(
    Effect.promise(startProviderEmulator),
    (emulator) =>
      Effect.gen(function* () {
        const binding = ResearchVerificationProvider.makeAiBinding({
          _tag: "LocalVerification",
          baseURL: emulator.origin,
        });
        const fileId = "web:00000000-0000-4000-8000-000000000289";
        const request = `Build a PDF from uploaded File ID ${fileId}.`;
        const loadedSkillResult =
          '{"skillId":"document-build","skillVersion":"system-document-build-v1"}';
        const deniedDocumentBuildResult =
          '{"_tag":"Denied","reason":"missingEntitlement","resetAt":null}';
        const loadSkillTool = {
          function: {
            name: "loadSkill",
            parameters: { properties: {}, type: "object" },
          },
          type: "function" as const,
        };
        const startDocumentBuildTool = {
          function: {
            name: "startDocumentBuild",
            parameters: { properties: {}, type: "object" },
          },
          type: "function" as const,
        };
        const configured = yield* Effect.promise(() =>
          fetch(
            `${emulator.origin}/_test/research/next-document-build-action?actionId=verification-startDocumentBuild-free-verify-289`,
            { method: "POST" },
          ),
        );
        expect(configured.status).toBe(204);
        const loadResponse = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [{ content: request, role: "user" }],
            tools: [loadSkillTool],
          }),
        );
        expect(loadResponse).toMatchObject({
          finish_reason: "tool_calls",
          tool_calls: [
            {
              arguments: {
                skillId: "document-build",
                skillVersion: "system-document-build-v1",
              },
              name: "loadSkill",
            },
          ],
        });
        const startResponse = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [
              { content: request, role: "user" },
              {
                content: loadedSkillResult,
                name: "loadSkill",
                role: "tool",
                tool_call_id: "verification-loadSkill",
              },
            ],
            tools: [loadSkillTool, startDocumentBuildTool],
          }),
        );
        expect(startResponse).toMatchObject({
          tool_calls: [
            {
              id: "verification-startDocumentBuild-free-verify-289",
              name: "startDocumentBuild",
            },
          ],
        });
        const denialResponse = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [
              { content: request, role: "user" },
              {
                content: loadedSkillResult,
                name: "loadSkill",
                role: "tool",
                tool_call_id: "verification-loadSkill",
              },
              {
                content: deniedDocumentBuildResult,
                name: "startDocumentBuild",
                role: "tool",
                tool_call_id: "verification-startDocumentBuild-free-verify-289",
              },
            ],
            tools: [loadSkillTool, startDocumentBuildTool],
          }),
        );
        expect(denialResponse).toMatchObject({
          finish_reason: "stop",
          response: "Document Build is not available on your current plan.",
        });
        const adventurerLoadResponse = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [{ content: request, role: "user" }],
            tools: [loadSkillTool],
          }),
        );
        expect(adventurerLoadResponse).toMatchObject({
          tool_calls: [{ id: "verification-loadSkill", name: "loadSkill" }],
        });
        const adventurerStartResponse = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [
              { content: request, role: "user" },
              {
                content: loadedSkillResult,
                name: "loadSkill",
                role: "tool",
                tool_call_id: "verification-loadSkill",
              },
            ],
            tools: [loadSkillTool, startDocumentBuildTool],
          }),
        );
        expect(adventurerStartResponse).toMatchObject({
          tool_calls: [{ id: "verification-startDocumentBuild", name: "startDocumentBuild" }],
        });
        const ledger = yield* Effect.promise(() =>
          fetch(`${emulator.origin}/_test/research/ledger`).then((response) => response.json()),
        );
        expect(ledger).toEqual(
          expect.arrayContaining([
            {
              kind: "tool-selection",
              operationId: "verification-loadSkill",
              selectedTool: "loadSkill",
              subject: "document-build@system-document-build-v1",
            },
            {
              kind: "tool-selection",
              operationId: "verification-startDocumentBuild-free-verify-289",
              selectedTool: "startDocumentBuild",
              subject: fileId,
            },
            {
              kind: "tool-selection",
              operationId: "verification-startDocumentBuild",
              selectedTool: "startDocumentBuild",
              subject: fileId,
            },
          ]),
        );
      }),
    (emulator) => Effect.promise(emulator.close),
  ),
);

it.effect("loads Document Build before inspecting the verifier's exact status request", () =>
  Effect.acquireUseRelease(
    Effect.promise(startProviderEmulator),
    (emulator) =>
      Effect.gen(function* () {
        const binding = ResearchVerificationProvider.makeAiBinding({
          _tag: "LocalVerification",
          baseURL: emulator.origin,
        });
        const workflowId = "document-build:verification-status-00000001";
        const request = `Inspect Document Build ${workflowId} status.`;
        const loadSkillTool = {
          function: {
            name: "loadSkill",
            parameters: { properties: {}, type: "object" },
          },
          type: "function" as const,
        };
        const inspectDocumentBuildTool = {
          function: {
            name: "inspectDocumentBuild",
            parameters: { properties: {}, type: "object" },
          },
          type: "function" as const,
        };
        const loadResponse = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [{ content: request, role: "user" }],
            tools: [loadSkillTool],
          }),
        );
        expect(loadResponse).toMatchObject({
          tool_calls: [
            {
              arguments: {
                skillId: "document-build",
                skillVersion: "system-document-build-v1",
              },
              name: "loadSkill",
            },
          ],
        });
        const inspectResponse = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [
              { content: request, role: "user" },
              {
                content: '{"skillId":"document-build","skillVersion":"system-document-build-v1"}',
                name: "loadSkill",
                role: "tool",
                tool_call_id: "verification-loadSkill",
              },
            ],
            tools: [loadSkillTool, inspectDocumentBuildTool],
          }),
        );
        expect(inspectResponse).toMatchObject({
          tool_calls: [
            {
              arguments: { workflowId },
              name: "inspectDocumentBuild",
            },
          ],
        });
        const finalResponse = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [
              { content: request, role: "user" },
              {
                content: '{"skillId":"document-build","skillVersion":"system-document-build-v1"}',
                name: "loadSkill",
                role: "tool",
                tool_call_id: "verification-loadSkill",
              },
              {
                content: `{"_tag":"Succeeded","workflowId":"${workflowId}"}`,
                name: "inspectDocumentBuild",
                role: "tool",
                tool_call_id: "verification-inspectDocumentBuild",
              },
            ],
            tools: [loadSkillTool, inspectDocumentBuildTool],
          }),
        );
        expect(finalResponse).toMatchObject({
          finish_reason: "stop",
          response: expect.stringContaining(`"workflowId":"${workflowId}"`),
        });
        expect(finalResponse).not.toHaveProperty("tool_calls");
        const ledger = yield* Effect.promise(() =>
          fetch(`${emulator.origin}/_test/research/ledger`).then((response) => response.json()),
        );
        expect(ledger).toEqual([
          {
            kind: "agent",
            operationId: null,
            subject: expect.stringContaining(request),
          },
          {
            kind: "tool-selection",
            operationId: "verification-loadSkill",
            selectedTool: "loadSkill",
            subject: "document-build@system-document-build-v1",
          },
          {
            kind: "agent",
            operationId: null,
            subject: expect.stringContaining("system-document-build-v1"),
          },
          {
            kind: "tool-selection",
            operationId: null,
            selectedTool: "inspectDocumentBuild",
            subject: workflowId,
          },
          {
            kind: "agent",
            operationId: null,
            subject: expect.stringContaining(workflowId),
          },
        ]);
      }),
    (emulator) => Effect.promise(emulator.close),
  ),
);
