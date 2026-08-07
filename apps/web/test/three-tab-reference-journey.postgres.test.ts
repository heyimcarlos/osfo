import {
  makeAgentRunWorkerLayer,
  makeDeterministicModelCallExecutorLayer,
  makeOutboxRelayLayer,
} from "@osfo/agent-run";
import { runStreamingPullWorker, StreamingPullSource } from "@osfo/agent-run-worker";
import { makeDeterministicAgentRuntimeLayer } from "@osfo/agent-runtime";
import type { AcceptanceReceipt } from "@osfo/api";
import { getThreadSnapshot, submitThreadMessage } from "@osfo/api/client";
import { makeAgentRunRepositoryLayer } from "@osfo/db";
import {
  referenceClientPrincipalId,
  seedReferenceClientAuthority,
} from "@osfo/db/reference-client";
import { prepareMessageAdmissionFixture, readReferenceJourneyAuthority } from "@osfo/db/testing";
import { startCompiledIngress } from "@osfo/ingress/testing";
import { runOutboxRelay } from "@osfo/outbox-relay";
import { makeGooglePubSubPublisherLayer } from "@osfo/outbox-relay/pubsub-publisher";
import type { ThreadSnapshot } from "@osfo/session";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { startGoogleChrome, startProductionReferenceClient } from "./reference-browser.js";
import { makeReferencePubSubBoundary } from "./reference-pubsub.js";
import { startThreeTabEvidenceCapture } from "./three-tab-evidence.js";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for the Oz Reference Journey");
}

const authenticationToken = "oz-three-tab-reference-session";
const contents = [
  "First from Oz",
  "Second from Oz",
  "Third from Oz",
  "Accepted during ingress replacement",
] as const;
const executionProfileRef = "oz.reference-journey.v1";
const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";

export class ReferenceJourneyTimeout extends Data.TaggedError("ReferenceJourneyTimeout")<{
  readonly position: string;
}> {}

const canonicalProjection = ({ throughCursor: _throughCursor, ...projection }: ThreadSnapshot) =>
  projection;

const resumedCursor = (eventRequestUrl: string) =>
  new URL(eventRequestUrl).searchParams.get("after");

const waitForAuthorityPosition = (origin: string, position: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const snapshot = yield* getThreadSnapshot({
        authenticationToken,
        baseUrl: origin,
        threadId,
      });
      if (snapshot.throughPosition === position) return snapshot;
      yield* Effect.sleep(25);
    }
    return yield* new ReferenceJourneyTimeout({ position });
  });

const waitForPublicationDrain = () =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const authority = yield* readReferenceJourneyAuthority(databaseUrl);
      if (
        authority.outbox.length === contents.length &&
        authority.outbox.every((obligation) => obligation.published) &&
        authority.relayDispatchCapacities[0]?.activeCount === 0 &&
        authority.relayPublicationTasks.length === 0
      ) {
        return authority;
      }
      yield* Effect.sleep(10);
    }
    return yield* new ReferenceJourneyTimeout({ position: "publication-drain" });
  });

describe("three-tab Oz Reference Journey", () => {
  it.live(
    "replays three Chrome tabs through drain and compiled ingress replacement",
    () =>
      Effect.gen(function* () {
        yield* prepareMessageAdmissionFixture(databaseUrl, { principals: [] });
        yield* seedReferenceClientAuthority({ authenticationToken, databaseUrl, threadId });

        const ingress = yield* startCompiledIngress({
          databaseUrl,
          executionProfileRef,
          streamPollIntervalMs: 10,
        });
        const client = yield* startProductionReferenceClient({
          authenticationToken,
          ingressOrigin: ingress.origin,
          threadId,
        });
        const chrome = yield* startGoogleChrome();
        const tabA = yield* chrome.openTab(client.origin, "A");
        const tabB = yield* chrome.openTab(client.origin, "B");
        const tabC = yield* chrome.openTab(client.origin, "C");

        for (const [tab, label] of [
          [tabA, "A"],
          [tabB, "B"],
          [tabC, "C"],
        ] as const) {
          yield* tab.waitForText(`Tab ${label}`);
          yield* tab.waitForText("Synchronized through 0");
        }
        yield* tabA.waitForProjection(threadId, "0");
        const initialB = yield* tabB.waitForProjection(threadId, "0");
        yield* tabC.waitForProjection(threadId, "0");
        const evidenceCapture = yield* startThreeTabEvidenceCapture({
          directory: process.env.OSFO_THREE_TAB_EVIDENCE_DIR,
          tabs: [tabA, tabB, tabC],
        });
        yield* evidenceCapture.mark("initial-synchronized", {});

        const pubsub = yield* makeReferencePubSubBoundary;
        const repositoryLayer = makeAgentRunRepositoryLayer({ databaseUrl });
        const workerLayer = makeAgentRunWorkerLayer({
          executionProfileRef,
          workerId: "reference-worker",
          leaseDurationMs: 30_000,
          leaseRenewalIntervalMs: 10_000,
          cancellationPollIntervalMs: 100,
        }).pipe(
          Layer.provide(repositoryLayer),
          Layer.provide(
            makeDeterministicAgentRuntimeLayer({
              executionProfileRef,
              modelBinding: "oz.deterministic.echo.v1",
            }),
          ),
          Layer.provide(makeDeterministicModelCallExecutorLayer()),
        );
        yield* Effect.forkScoped(
          runStreamingPullWorker({ drainTimeoutMs: 1_000, executionSlots: 1 }).pipe(
            Effect.provide(workerLayer),
            Effect.provide(Layer.succeed(StreamingPullSource, pubsub.source)),
          ),
        );
        yield* pubsub.sourceStarted;

        const publisherLayer = makeGooglePubSubPublisherLayer({
          projectId: "osfo-reference",
          requestTimeoutMs: 5_000,
          topicId: "agent-runs",
        }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, pubsub.httpClient)));
        const relayLayer = makeOutboxRelayLayer({
          relayId: "reference-relay",
          leaseDurationMs: 30_000,
          publicationWindowSize: 32,
        }).pipe(Layer.provide(repositoryLayer), Layer.provide(publisherLayer));
        yield* Effect.forkScoped(
          runOutboxRelay({ publisherConcurrency: 1, safetyDrainIntervalMs: 10 }).pipe(
            Effect.provide(relayLayer),
          ),
        );

        const receipts: Array<AcceptanceReceipt> = [];

        const tabBRequestCount = yield* tabB.eventRequestCount();
        yield* tabB.disconnect();
        yield* evidenceCapture.mark("tab-b-disconnected", {
          tab: "B",
          fromPosition: initialB.throughPosition,
        });
        const firstReceipt = yield* tabA.submitMessage(contents[0]);
        receipts.push(firstReceipt);
        expect(firstReceipt.threadPosition).toBe("1");
        expect(yield* pubsub.waitForSettlement(0)).toBe("acknowledged");
        const throughFive = yield* waitForAuthorityPosition(ingress.origin, "5");
        yield* evidenceCapture.mark("first-message-completed", {
          tab: "A",
          toPosition: throughFive.throughPosition,
        });
        yield* tabB.resume();
        const tabBResponse = yield* tabB.waitForEventResponseAfter(tabBRequestCount);
        expect(tabBResponse.status).toBe(200);
        expect(resumedCursor(tabBResponse.url)).toBe(initialB.throughCursor);
        const replayedB = yield* tabB.waitForProjection(threadId, "5");
        expect(replayedB.throughPosition).not.toBe(initialB.throughPosition);
        yield* tabB.waitForText("Echo: First from Oz");
        yield* tabB.waitForText("Synchronized through 5");
        yield* evidenceCapture.mark("tab-b-resumed-from-own-cursor", {
          tab: "B",
          fromPosition: initialB.throughPosition,
          toPosition: replayedB.throughPosition,
        });

        const beforeC = yield* tabC.waitForProjection(threadId, "5");
        const tabCRequestCount = yield* tabC.eventRequestCount();
        yield* tabC.disconnect();
        yield* evidenceCapture.mark("tab-c-disconnected", {
          tab: "C",
          fromPosition: beforeC.throughPosition,
        });
        const secondReceipt = yield* tabB.submitMessage(contents[1]);
        receipts.push(secondReceipt);
        expect(secondReceipt.threadPosition).toBe("6");
        expect(yield* pubsub.waitForSettlement(1)).toBe("acknowledged");
        const throughTen = yield* waitForAuthorityPosition(ingress.origin, "10");
        yield* evidenceCapture.mark("second-message-completed", {
          tab: "B",
          toPosition: throughTen.throughPosition,
        });
        yield* tabC.resume();
        const tabCResponse = yield* tabC.waitForEventResponseAfter(tabCRequestCount);
        expect(tabCResponse.status).toBe(200);
        expect(resumedCursor(tabCResponse.url)).toBe(beforeC.throughCursor);
        const replayedC = yield* tabC.waitForProjection(threadId, "10");
        expect(replayedC.throughPosition).not.toBe(beforeC.throughPosition);
        yield* tabC.waitForText("Echo: Second from Oz");
        yield* tabC.waitForText("Synchronized through 10");
        yield* evidenceCapture.mark("tab-c-resumed-from-own-cursor", {
          tab: "C",
          fromPosition: beforeC.throughPosition,
          toPosition: replayedC.throughPosition,
        });

        const beforeA = yield* tabA.waitForProjection(threadId, "10");
        const tabARequestCount = yield* tabA.eventRequestCount();
        yield* tabA.disconnect();
        yield* evidenceCapture.mark("tab-a-disconnected", {
          tab: "A",
          fromPosition: beforeA.throughPosition,
        });
        const thirdReceipt = yield* tabC.submitMessage(contents[2]);
        receipts.push(thirdReceipt);
        expect(thirdReceipt.threadPosition).toBe("11");
        expect(yield* pubsub.waitForSettlement(2)).toBe("acknowledged");
        const throughFifteen = yield* waitForAuthorityPosition(ingress.origin, "15");
        yield* evidenceCapture.mark("third-message-completed", {
          tab: "C",
          toPosition: throughFifteen.throughPosition,
        });
        yield* tabA.resume();
        const tabAResponse = yield* tabA.waitForEventResponseAfter(tabARequestCount);
        expect(tabAResponse.status).toBe(200);
        expect(resumedCursor(tabAResponse.url)).toBe(beforeA.throughCursor);
        const replayedA = yield* tabA.waitForProjection(threadId, "15");
        expect(replayedA.throughPosition).not.toBe(beforeA.throughPosition);
        yield* tabA.waitForText("Echo: Third from Oz");
        yield* tabA.waitForText("Synchronized through 15");
        yield* evidenceCapture.mark("tab-a-resumed-from-own-cursor", {
          tab: "A",
          fromPosition: beforeA.throughPosition,
          toPosition: replayedA.throughPosition,
        });

        const beforeReplacement = yield* Effect.all([
          Effect.succeed(replayedA),
          tabB.waitForProjection(threadId, "15"),
          tabC.waitForProjection(threadId, "15"),
        ]);
        expect(beforeReplacement.map(canonicalProjection)).toEqual(
          Array.from({ length: 3 }, () => canonicalProjection(throughFifteen)),
        );
        const requestCounts = yield* Effect.all([
          tabA.eventRequestCount(),
          tabB.eventRequestCount(),
          tabC.eventRequestCount(),
        ]);
        const plannedDrain = yield* ingress.terminate;
        expect(plannedDrain).toMatchObject({
          exitCode: 130,
          fallbackInvoked: false,
          sentSignal: "SIGTERM",
          drain: {
            accepting: false,
            activeConnections: 0,
            httpServerListening: true,
          },
          shutdownSequence: ["drained", "http_closed"],
        });
        const alternateIngress = yield* startCompiledIngress({
          databaseUrl,
          executionProfileRef,
          streamPollIntervalMs: 10,
        });
        const replacementReceipt = yield* submitThreadMessage({
          authenticationToken,
          baseUrl: alternateIngress.origin,
          idempotencyKey: crypto.randomUUID(),
          message: { content: contents[3] },
          threadId,
        });
        receipts.push(replacementReceipt);
        expect(replacementReceipt.threadPosition).toBe("16");
        expect(yield* pubsub.waitForSettlement(3)).toBe("acknowledged");
        const throughTwenty = yield* waitForAuthorityPosition(alternateIngress.origin, "20");
        yield* alternateIngress.terminate;
        yield* startCompiledIngress({
          databaseUrl,
          executionProfileRef,
          port: ingress.port,
          streamPollIntervalMs: 10,
        });
        const resumedResponses = yield* Effect.all(
          [tabA, tabB, tabC].map((tab, index) =>
            tab.waitForSuccessfulEventResponseAfter(requestCounts[index]!),
          ),
        );
        expect(resumedResponses.map((response) => response.status)).toEqual([200, 200, 200]);
        expect(resumedResponses.map((response) => resumedCursor(response.url))).toEqual(
          beforeReplacement.map((projection) => projection.throughCursor),
        );

        const finalProjections = yield* Effect.all([
          tabA.waitForProjection(threadId, "20"),
          tabB.waitForProjection(threadId, "20"),
          tabC.waitForProjection(threadId, "20"),
        ]);
        const authoritativeProjection = canonicalProjection(throughTwenty);
        expect(finalProjections.map(canonicalProjection)).toEqual([
          authoritativeProjection,
          authoritativeProjection,
          authoritativeProjection,
        ]);
        for (const tab of [tabA, tabB, tabC]) {
          for (const content of contents) {
            yield* tab.waitForText(content);
            yield* tab.waitForText(`Echo: ${content}`);
          }
          yield* tab.waitForText("Synchronized through 20");
        }

        expect(pubsub.publications).toHaveLength(contents.length);
        expect(pubsub.publications.map((publication) => publication.orderingKey)).toEqual(
          contents.map(() => threadId),
        );

        const authority = yield* waitForPublicationDrain();
        expect(authority.principals).toEqual([{ principalId: referenceClientPrincipalId }]);
        expect(authority.authenticationSessions).toEqual([
          { principalId: referenceClientPrincipalId },
        ]);
        expect(authority.threads).toEqual([{ principalId: referenceClientPrincipalId, threadId }]);
        expect(authority.receipts).toEqual(
          receipts.map((receipt) => ({
            agentRunId: receipt.agentRunId,
            idempotencyKey: receipt.idempotencyKey,
            principalId: referenceClientPrincipalId,
            protocolVersion: 1,
            receiptId: receipt.receiptId,
            threadId,
            threadPosition: receipt.threadPosition,
            userMessageId: receipt.userMessageId,
          })),
        );
        expect(authority.userMessages).toHaveLength(contents.length);
        expect(authority.userMessages).toEqual(
          expect.arrayContaining(
            receipts.map((receipt, index) => ({
              content: contents[index],
              principalId: referenceClientPrincipalId,
              threadId,
              userMessageId: receipt.userMessageId,
            })),
          ),
        );
        expect(authority.agentRuns).toHaveLength(contents.length);
        expect(authority.agentRuns).toEqual(
          expect.arrayContaining(
            receipts.map((receipt) => ({
              agentRunId: receipt.agentRunId,
              executionProfileRef,
              principalId: referenceClientPrincipalId,
              state: "succeeded",
              threadId,
              userMessageId: receipt.userMessageId,
            })),
          ),
        );
        expect(authority.reservations).toHaveLength(contents.length);
        expect(authority.reservations).toEqual(
          expect.arrayContaining(
            receipts.map((receipt) => ({
              agentRunId: receipt.agentRunId,
              principalId: referenceClientPrincipalId,
              state: "released",
            })),
          ),
        );
        expect(authority.assistantOutputs).toHaveLength(contents.length);
        expect(
          authority.assistantOutputs.map(({ agentRunId, state }) => ({ agentRunId, state })),
        ).toEqual(
          expect.arrayContaining(
            receipts.map((receipt) => ({ agentRunId: receipt.agentRunId, state: "completed" })),
          ),
        );
        expect(authority.modelCalls).toHaveLength(contents.length);
        expect(
          authority.modelCalls.map(({ agentRunId, state }) => ({ agentRunId, state })),
        ).toEqual(
          expect.arrayContaining(
            receipts.map((receipt) => ({ agentRunId: receipt.agentRunId, state: "succeeded" })),
          ),
        );
        expect(authority.modelCallAttempts).toHaveLength(contents.length);
        expect(
          authority.modelCallAttempts.map(({ agentRunId, attemptNumber, claimEpoch, state }) => ({
            agentRunId,
            attemptNumber,
            claimEpoch,
            state,
          })),
        ).toEqual(
          expect.arrayContaining(
            receipts.map((receipt) => ({
              agentRunId: receipt.agentRunId,
              attemptNumber: 1,
              claimEpoch: "1",
              state: "succeeded",
            })),
          ),
        );
        expect(authority.modelCallFragments).toHaveLength(contents.length * 2);
        expect(
          authority.modelCallFragments.map(({ agentRunId, fragmentIndex, text }) => ({
            agentRunId,
            fragmentIndex,
            text,
          })),
        ).toEqual(
          expect.arrayContaining(
            receipts.flatMap((receipt, index) => [
              { agentRunId: receipt.agentRunId, fragmentIndex: 0, text: "Echo: " },
              { agentRunId: receipt.agentRunId, fragmentIndex: 1, text: contents[index] },
            ]),
          ),
        );
        expect(authority.globalCapacities).toEqual([{ reservedCount: 0 }]);
        expect(authority.principalCapacities).toEqual([
          { principalId: referenceClientPrincipalId, reservedCount: 0 },
        ]);
        expect(authority.relayPrincipals).toEqual([{ principalId: referenceClientPrincipalId }]);
        expect(authority.relayThreads).toEqual([
          { principalId: referenceClientPrincipalId, threadId },
        ]);
        expect(authority.relayDispatchCapacities).toEqual([{ activeCount: 0 }]);
        expect(authority.relayPublicationTasks).toEqual([]);

        const expectedEvents = receipts.flatMap((receipt, runIndex) =>
          [
            "UserMessageAppended",
            "AssistantOutputAppended",
            "AssistantOutputAppended",
            "AssistantOutputCompleted",
            "AgentRunSucceeded",
          ].map((eventType, eventIndex) => ({
            agentRunId: receipt.agentRunId,
            eventType,
            position: String(runIndex * 5 + eventIndex + 1),
            principalId: referenceClientPrincipalId,
            threadId,
            userMessageId: receipt.userMessageId,
          })),
        );
        expect(authority.events.map(({ eventId: _eventId, ...event }) => event)).toEqual(
          expectedEvents,
        );
        expect(new Set(authority.events.map((event) => event.eventId)).size).toBe(
          contents.length * 5,
        );
        expect(authority.outbox).toHaveLength(contents.length);
        expect(
          authority.outbox.map(({ outboxId: _outboxId, ...obligation }) => obligation),
        ).toEqual(
          expect.arrayContaining(
            receipts.map((receipt, index) => ({
              agentRunId: receipt.agentRunId,
              principalId: referenceClientPrincipalId,
              publicationEvidence: {
                providerMessageId: `reference-pubsub-${index + 1}`,
                type: "pubsub",
              },
              published: true,
              threadId,
            })),
          ),
        );
        expect(new Set(authority.outbox.map((obligation) => obligation.outboxId)).size).toBe(
          contents.length,
        );
        expect(authority.relayPublicationAttempts).toHaveLength(contents.length);
        expect(
          authority.relayPublicationAttempts.map(
            ({ providerMessageId, publicationEpoch, publicationOwner, state }) => ({
              providerMessageId,
              publicationEpoch,
              publicationOwner,
              state,
            }),
          ),
        ).toEqual(
          expect.arrayContaining(
            receipts.map((_receipt, index) => ({
              providerMessageId: `reference-pubsub-${index + 1}`,
              publicationEpoch: "1",
              publicationOwner: "reference-relay",
              state: "confirmed",
            })),
          ),
        );
        expect(
          new Set(authority.relayPublicationAttempts.map((attempt) => attempt.outboxId)),
        ).toEqual(new Set(authority.outbox.map((obligation) => obligation.outboxId)));
        expect(throughFive.throughPosition).toBe("5");
        expect(throughTen.throughPosition).toBe("10");
        expect(throughTwenty.activeState).toEqual([]);
        yield* evidenceCapture.mark("all-projections-reconciled", { toPosition: "20" });
        yield* evidenceCapture.stop;
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    90_000,
  );
});
