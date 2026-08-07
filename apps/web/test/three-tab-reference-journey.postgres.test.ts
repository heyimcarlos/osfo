import {
  AgentRunWorker,
  OutboxRelay,
  RunnableDeliveryPublisher,
  makeAgentRunWorkerLayer,
  makeDeterministicModelCallExecutorLayer,
  makeOutboxRelayLayer,
  type RunnableAgentRunDelivery,
} from "@osfo/agent-run";
import { makeDeterministicAgentRuntimeLayer } from "@osfo/agent-runtime";
import { getThreadSnapshot } from "@osfo/api/client";
import { makeAgentRunRepositoryLayer } from "@osfo/db";
import {
  referenceClientPrincipalId,
  seedReferenceClientAuthority,
} from "@osfo/db/reference-client";
import { prepareMessageAdmissionFixture, readReferenceJourneyAuthority } from "@osfo/db/testing";
import { describe, expect, it } from "@effect/vitest";
import type { ThreadSnapshot } from "@osfo/session";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { startCompiledIngress } from "./compiled-ingress.js";
import { startGoogleChrome, startProductionReferenceClient } from "./reference-browser.js";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for the Oz Reference Journey");
}

const authenticationToken = "oz-three-tab-reference-session";
const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";

const canonicalProjection = ({ throughCursor: _throughCursor, ...projection }: ThreadSnapshot) =>
  projection;

describe("three-tab Oz Reference Journey", () => {
  it.live(
    "converges independently resumed Chrome tabs against PostgreSQL authority",
    () =>
      Effect.gen(function* () {
        yield* prepareMessageAdmissionFixture(databaseUrl, { principals: [] });
        yield* seedReferenceClientAuthority({ authenticationToken, databaseUrl, threadId });

        const ingress = yield* startCompiledIngress(databaseUrl);
        const client = yield* startProductionReferenceClient({
          authenticationToken,
          ingressOrigin: ingress.origin,
          threadId,
        });
        const chrome = yield* startGoogleChrome();
        const tabA = yield* chrome.openTab(client.origin, "A");
        const tabB = yield* chrome.openTab(client.origin, "B");
        const tabC = yield* chrome.openTab("about:blank", "C");

        yield* tabA.waitForText("Synchronized through 0");
        yield* tabA.waitForText("Tab A");
        yield* tabB.waitForText("Synchronized through 0");
        yield* tabB.waitForText("Tab B");
        const initialA = yield* tabA.waitForProjection(threadId, "0");
        const initialB = yield* tabB.waitForProjection(threadId, "0");
        expect(canonicalProjection(initialA)).toEqual(canonicalProjection(initialB));

        yield* tabB.disconnect();
        expect(yield* tabB.location()).toBe("about:blank");
        const receipt = yield* tabA.submitMessage("Hello, Oz");
        expect(receipt).toMatchObject({
          protocolVersion: 1,
          threadId,
          threadPosition: "1",
        });

        const published: Array<RunnableAgentRunDelivery> = [];
        const repositoryLayer = makeAgentRunRepositoryLayer({ databaseUrl });
        const publisherLayer = Layer.succeed(
          RunnableDeliveryPublisher,
          RunnableDeliveryPublisher.of({
            publish: (delivery) =>
              Effect.sync(() => {
                published.push(delivery);
                return { providerMessageId: `reference-delivery-${published.length}` };
              }),
          }),
        );
        const relayLayer = makeOutboxRelayLayer({
          relayId: "reference-relay",
          leaseDurationMs: 30_000,
          publicationWindowSize: 32,
        }).pipe(Layer.provide(repositoryLayer), Layer.provide(publisherLayer));
        const workerLayer = makeAgentRunWorkerLayer({
          executionProfileRef: "oz.reference-journey.v1",
          workerId: "reference-worker",
          leaseDurationMs: 30_000,
        }).pipe(
          Layer.provide(repositoryLayer),
          Layer.provide(
            makeDeterministicAgentRuntimeLayer({
              executionProfileRef: "oz.reference-journey.v1",
              modelBinding: "oz.deterministic.echo.v1",
            }),
          ),
          Layer.provide(makeDeterministicModelCallExecutorLayer()),
        );

        yield* OutboxRelay.use((relay) => relay.selectOnce()).pipe(Effect.provide(relayLayer));
        yield* OutboxRelay.use((relay) => relay.publishOnce()).pipe(Effect.provide(relayLayer));
        expect(published).toHaveLength(1);
        expect(published[0]?.agentRunId).toBe(receipt.agentRunId);
        const workerOutcome = yield* AgentRunWorker.use((worker) =>
          worker.handle(published[0]!),
        ).pipe(Effect.provide(workerLayer));
        expect(workerOutcome).toEqual({ type: "acknowledge", outcome: "succeeded" });

        const authoritySnapshot = yield* getThreadSnapshot({
          authenticationToken,
          baseUrl: ingress.origin,
          threadId,
        });
        const finalA = yield* tabA.waitForProjection(threadId, authoritySnapshot.throughPosition);
        expect(yield* tabC.location()).toBe("about:blank");

        yield* tabB.resume();
        yield* tabC.navigate(client.origin);
        yield* tabC.waitForText("Tab C");
        const finalB = yield* tabB.waitForProjection(threadId, authoritySnapshot.throughPosition);
        const finalC = yield* tabC.waitForProjection(threadId, authoritySnapshot.throughPosition);
        const authoritativeProjection = canonicalProjection(authoritySnapshot);
        expect(canonicalProjection(finalA)).toEqual(authoritativeProjection);
        expect(canonicalProjection(finalB)).toEqual(authoritativeProjection);
        expect(canonicalProjection(finalC)).toEqual(authoritativeProjection);

        for (const tab of [tabA, tabB, tabC]) {
          const previousRequests = yield* tab.eventRequestCount();
          yield* tab.disconnect();
          yield* Effect.sleep(50);
          yield* tab.resume();
          yield* tab.waitForEventRequestAfter(previousRequests);
          expect(canonicalProjection(yield* tab.readRequiredProjection(threadId))).toEqual(
            authoritativeProjection,
          );
          yield* tab.waitForText("Hello, Oz");
          yield* tab.waitForText("Echo: Hello, Oz");
          yield* tab.waitForText(`Synchronized through ${authoritySnapshot.throughPosition}`);
        }

        const authority = yield* readReferenceJourneyAuthority(databaseUrl, receipt);
        expect(authority).toEqual({
          acceptanceReceipts: "1",
          agentRunState: "succeeded",
          agentRuns: "1",
          eventTypes: [
            "UserMessageAppended",
            "AssistantOutputAppended",
            "AssistantOutputAppended",
            "AssistantOutputCompleted",
            "AgentRunSucceeded",
          ],
          globalReserved: 0,
          principalId: referenceClientPrincipalId,
          principalReserved: 0,
          reservationState: "released",
          terminalEvents: "1",
          threadPositions: ["1", "2", "3", "4", "5"],
          userMessages: "1",
        });
        expect(authoritySnapshot.activeState).toEqual([]);
        expect(authoritySnapshot.throughPosition).toBe("5");
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    60_000,
  );
});
