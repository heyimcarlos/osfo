/* oxlint-disable vitest/no-standalone-expect, eslint/no-underscore-dangle -- Assertions execute inside Effects and provider outcomes use _tag. */
/* oxlint-disable effecttsgo/global-date-in-effect, effecttsgo/global-fetch-in-effect -- This Node boundary test owns fixed evidence time and emulator ledger I/O. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { launchModelAccessPolicy } from "../../domain/model-access-policy";
import { ResearchCollector } from "../../services/research-collector";
import { ResearchReport } from "../../services/research-report";
import { ResearchSynthesis } from "../../services/research-synthesis";
import { startProviderEmulator } from "../../../test/emulators/provider-emulator";
import { ResearchVerificationProvider } from "./research-verification-provider";

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
        const ledger = yield* Effect.promise(() =>
          fetch(`${emulator.origin}/_test/research/ledger`).then((result) => result.json()),
        );
        expect(ledger).toEqual([
          {
            kind: "agent",
            operationId: null,
            subject: expect.stringContaining("Connect this Telegram chat"),
          },
        ]);
      }),
    (emulator) => Effect.promise(emulator.close),
  ),
);
