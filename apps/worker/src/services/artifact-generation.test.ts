/* oxlint-disable eslint/no-underscore-dangle, vitest/no-standalone-expect, effecttsgo/global-date, effecttsgo/prefer-schema-over-json -- Tagged unions, fixed dates, and Effect assertions are deterministic fixtures. */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AllowancePeriodId,
  CapabilityCatalogVersion,
  ChannelLinkId,
  PlanPolicyVersion,
  UserId,
} from "../domain";
import { ChannelAuthorId, ChannelId } from "../domain/channel-link";
import { ActionId } from "../domain/action-execution";
import { DocumentArtifact } from "../domain/document-artifact";
import { ArtifactGeneration } from "./artifact-generation";

describe("Artifact Generation", () => {
  it.effect(
    "creates an immutable verified presentation and exports only its trusted reference",
    () =>
      Effect.gen(function* () {
        const fixture = makeFixture();
        const artifact = yield* fixture.service.generate(
          request({
            _tag: "Presentation",
            source: presentation("Quarterly review"),
          }),
        );

        expect(artifact).toMatchObject({
          artifactRole: { _tag: "GeneratedPresentationV1", slideCount: 1 },
          lineage: { sourceContentId: null },
        });
        expect(fixture.retained).toHaveLength(1);
        expect(JSON.stringify(artifact)).not.toMatch(/sandbox|workspace|provider-secret/u);
      }),
  );

  it.effect("revises one owned presentation into a new identity without mutating the source", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const source = yield* fixture.service.generate(
        request({ _tag: "Presentation", source: presentation("First version") }),
      );
      const revised = yield* fixture.service.revise({
        ...request({ _tag: "Presentation", source: presentation("Accepted correction") }),
        actionId: ActionId.make("tool-revision"),
        owner: { _tag: "ToolCall", toolCallId: "tool-revision" },
        sourceContentId: source.content.contentId,
      });

      expect(revised.content.contentId).not.toBe(source.content.contentId);
      expect(revised.lineage.sourceContentId).toBe(source.content.contentId);
      expect(fixture.retained.map(({ artifact }) => artifact.content.contentId)).toEqual([
        source.content.contentId,
        revised.content.contentId,
      ]);
    }),
  );

  it.effect("retains verified image and diagram outputs under their distinct roles", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const image = yield* fixture.service.generate(
        request({
          _tag: "Image",
          source: { altText: "A potato", height: 512, prompt: "A potato", width: 512 },
        }),
      );
      const diagram = yield* fixture.service.generate({
        ...request({
          _tag: "Diagram",
          source: {
            direction: "leftToRight",
            edges: [{ from: "start", label: "then", to: "finish" }],
            height: 512,
            nodes: [
              { id: "start", label: "Start" },
              { id: "finish", label: "Finish" },
            ],
            title: "Flow",
            width: 768,
          },
        }),
        actionId: ActionId.make("tool-diagram"),
        owner: { _tag: "ToolCall", toolCallId: "tool-diagram" },
      });

      expect(image.artifactRole._tag).toBe("GeneratedImageV1");
      expect(diagram.artifactRole._tag).toBe("GeneratedDiagramV1");
    }),
  );

  it.effect("rejects a failed visual inspection before retention", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ visualInspectionPassed: false });
      const exit = yield* Effect.exit(
        fixture.service.generate(
          request({ _tag: "Presentation", source: presentation("Clipped") }),
        ),
      );

      expect(exit._tag).toBe("Failure");
      expect(fixture.retained).toHaveLength(0);
    }),
  );

  it.effect("replays one owning identity without recompute or duplicate retention", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const sameRequest = request({ _tag: "Presentation", source: presentation("Replay") });
      const first = yield* fixture.service.generate(sameRequest);
      const second = yield* fixture.service.generate(sameRequest);

      expect(second).toEqual(first);
      expect(fixture.computations()).toBe(1);
      expect(fixture.retained).toHaveLength(1);
    }),
  );

  it.effect("replays a retained revision after its source has been deleted", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const source = yield* fixture.service.generate(
        request({ _tag: "Presentation", source: presentation("Source") }),
      );
      const revisionRequest = {
        ...request({ _tag: "Presentation" as const, source: presentation("Revision") }),
        actionId: ActionId.make("tool-replay-revision"),
        owner: { _tag: "ToolCall" as const, toolCallId: "tool-replay-revision" },
        sourceContentId: source.content.contentId,
      };
      const revision = yield* fixture.service.revise(revisionRequest);

      fixture.retained.splice(0, 1);
      const replay = yield* fixture.service.revise(revisionRequest);

      expect(replay).toEqual(revision);
      expect(fixture.computations()).toBe(2);
      expect(fixture.retained).toHaveLength(1);
    }),
  );

  it.effect("rejects revision of a presentation owned by another User", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const source = yield* fixture.service.generate(
        request({ _tag: "Presentation", source: presentation("Owned") }),
      );
      const retained = fixture.retained[0];
      if (retained === undefined) throw new Error("source fixture missing");
      fixture.retained[0] = { ...retained, userId: UserId.make("user-other") };

      const exit = yield* Effect.exit(
        fixture.service.revise({
          ...request({ _tag: "Presentation", source: presentation("Stolen") }),
          actionId: ActionId.make("revision-other"),
          owner: { _tag: "ToolCall", toolCallId: "revision-other" },
          sourceContentId: source.content.contentId,
        }),
      );
      expect(exit._tag).toBe("Failure");
      expect(fixture.retained).toHaveLength(1);
    }),
  );

  it.effect("records interrupted incurred cost without retaining an unverified artifact", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ interrupted: true });
      const exit = yield* Effect.exit(
        fixture.service.generate(
          request({ _tag: "Presentation", source: presentation("Interrupted") }),
        ),
      );

      expect(exit._tag).toBe("Failure");
      expect(fixture.retained).toHaveLength(0);
      expect(fixture.recordedCosts()).toEqual([50_000n]);
    }),
  );

  it.effect("does not dispose a live Sandbox owned by another caller", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ pending: true });
      const exit = yield* Effect.exit(
        fixture.service.generate(
          request({ _tag: "Presentation", source: presentation("Concurrent") }),
        ),
      );

      expect(exit._tag).toBe("Failure");
      expect(fixture.disposals()).toBe(0);
      expect(fixture.retained).toHaveLength(0);
    }),
  );

  it.effect("records an over-limit provider cost and rejects retention", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ incurredUsdMicros: 50_001n });
      const failure = yield* fixture.service
        .generate(request({ _tag: "Presentation", source: presentation("Over limit") }))
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "ArtifactCostLimitExceeded",
        admittedUsdMicros: 50_000n,
        incurredUsdMicros: 50_001n,
      });
      expect(fixture.retained).toHaveLength(0);
      expect(fixture.recordedCosts()).toEqual([50_001n]);
    }),
  );

  it.effect("rejects output above the admitted Plan byte capacity", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ maximumOutputBytes: 8n });
      const exit = yield* Effect.exit(
        fixture.service.generate(
          request({ _tag: "Presentation", source: presentation("Plan byte bound") }),
        ),
      );

      expect(exit._tag).toBe("Failure");
      expect(fixture.retained).toHaveLength(0);
    }),
  );

  it.effect("deletes one retained identity and makes later reads fail closed", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const artifact = yield* fixture.service.generate(
        request({ _tag: "Diagram", source: diagram("Delete") }),
      );
      yield* fixture.service.delete({
        actionId: ActionId.make("delete-1"),
        authorization: request({ _tag: "Diagram", source: diagram("Delete") }).authorization,
        contentId: artifact.content.contentId,
      });
      const read = yield* Effect.exit(
        fixture.service.reference({
          actionId: ActionId.make("read-after-delete"),
          authorization: request({ _tag: "Diagram", source: diagram("Delete") }).authorization,
          contentId: artifact.content.contentId,
        }),
      );
      expect(fixture.retained).toHaveLength(0);
      expect(read._tag).toBe("Failure");
    }),
  );
});

const userId = UserId.make("user-artifact");
const allowancePeriodId = AllowancePeriodId.make("allowance-artifact");
const planPolicyVersion = PlanPolicyVersion.make("shared-usage-v1");
const capabilityCatalogVersion = CapabilityCatalogVersion.make("governed-capabilities-v1");
const channelLinkId = ChannelLinkId.make("link-1");
const channelAddress = {
  authorId: ChannelAuthorId.make("author-1"),
  channelId: ChannelId.make("channel-1"),
};

const request = <Intent extends ArtifactGeneration.ArtifactIntent>(intent: Intent) => ({
  actionId: ActionId.make("tool-artifact"),
  authorization: {
    allowance: {
      _tag: "Metered" as const,
      allowancePeriodId,
      endsAt: new Date("2026-09-01T00:00:00Z"),
      plan: "free" as const,
      planPolicyVersion,
      startsAt: new Date("2026-08-01T00:00:00Z"),
      usage: [],
    },
    approval: null,
    authority: { _tag: "ChannelLink" as const, address: channelAddress, channelLinkId, userId },
    deletionAccess: { _tag: "DeletionAccessAvailable" as const },
    gmailConnection: null,
    integrationConnections: [],
    liveFacts: {
      activeGmSummonsInSession: 0n,
      activeReminders: 0n,
      concurrentCostlyJobs: 0n,
      concurrentExhaustedConnectorReads: 0n,
      concurrentExhaustedConversations: 0n,
      concurrentIntegrationEffects: 0n,
      concurrentWorkflows: 0n,
      exhaustedConnectorReadsInRollingDay: 0n,
      gmSummonsInPeriod: 0n,
      retainedFileBytes: 0n,
    },
    now: new Date("2026-08-27T00:00:00Z"),
    originatingAuthority: { _tag: "ChannelLink" as const, channelLinkId },
    requestVendorUsdMicros: 50_000n,
    resourceOwnerUserId: userId,
    subscription: { plan: "free" as const, planPolicyVersion },
    user: { _tag: "ActiveUser" as const, userId },
  },
  intent,
  owner: { _tag: "ToolCall" as const, toolCallId: "tool-artifact" },
});

const presentation = (title: string) => ({
  audience: "The current User",
  purpose: "Explain the work",
  slides: [
    {
      body: ["One clear point"],
      diagramContentId: null,
      imageContentId: null,
      sourceNotes: [],
      speakerNotes: "",
      title,
    },
  ],
  title,
});

const diagram = (title: string) => ({
  direction: "leftToRight" as const,
  edges: [] as const,
  height: 400,
  nodes: [{ id: "one", label: "One" }] as const,
  title,
  width: 600,
});

const makeFixture = (
  options: {
    readonly incurredUsdMicros?: bigint;
    readonly interrupted?: boolean;
    readonly maximumOutputBytes?: bigint;
    readonly pending?: boolean;
    readonly visualInspectionPassed?: boolean;
  } = {},
) => {
  const retained: Array<ArtifactGeneration.StoredArtifact> = [];
  const recordedCosts: Array<bigint> = [];
  let computations = 0;
  let disposals = 0;
  const service = ArtifactGeneration.make({
    allowances: {
      record: (_allowancePeriodId, _source, items) =>
        Effect.sync(() => {
          recordedCosts.push(...items.map(({ quantity }) => quantity));
          return { _tag: "Recorded" as const };
        }),
    },
    artifacts: {
      account: () => Effect.void,
      delete: (metadata) =>
        Effect.sync(() => {
          const index = retained.findIndex(
            ({ artifact }) => artifact.content.contentId === metadata.artifact.content.contentId,
          );
          if (index >= 0) retained.splice(index, 1);
        }),
      inspect: (contentId) =>
        Effect.succeed(
          retained.find(({ artifact }) => artifact.content.contentId === contentId) ?? null,
        ),
      put: (artifact) => Effect.sync(() => retained.push(artifact)),
      readBytes: (metadata) =>
        Effect.succeed(
          retained.find(
            ({ artifact }) => artifact.content.contentId === metadata.artifact.content.contentId,
          )?.bytes ?? new Uint8Array(),
        ),
    },
    authorization: {
      admit: () => ({
        _tag: "Admitted" as const,
        allowancePeriod: { _tag: "Metered" as const, allowancePeriodId, grantSource: null },
        capabilityCatalogVersion,
        executionMode: "normalPlanUsage" as const,
        manifestVersion: null,
      }),
      recheck: () => ({ _tag: "Permitted" as const }),
    },
    compute: {
      dispose: () => Effect.sync(() => void (disposals += 1)),
      generate: (input) =>
        Effect.sync(() => {
          computations += 1;
          if (options.pending === true) {
            return {
              _tag: "AttemptPending" as const,
              cost: { _tag: "ProvenNoUse" as const },
              evidence: "another caller owns the lease",
            };
          }
          if (options.interrupted === true) {
            return {
              _tag: "Interrupted" as const,
              cost: {
                _tag: "Incurred" as const,
                allowancePeriodId,
                basis: "conservative" as const,
                providerOperationId: "artifact-operation-1",
                usdMicros: 50_000n,
              },
              evidence: "sandbox stopped",
            };
          }
          return {
            _tag: "Completed" as const,
            bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
            cost:
              options.incurredUsdMicros === undefined
                ? { _tag: "ProvenNoUse" as const }
                : {
                    _tag: "Incurred" as const,
                    allowancePeriodId,
                    basis: "conservative" as const,
                    providerOperationId: "artifact-operation-completed",
                    usdMicros: options.incurredUsdMicros,
                  },
            inspection:
              input.intent._tag === "Presentation"
                ? {
                    _tag: "Presentation" as const,
                    issues: options.visualInspectionPassed === false ? ["clipping"] : [],
                    renderedSlideCount: input.intent.source.slides.length,
                  }
                : {
                    _tag: "Visual" as const,
                    height: input.intent.source.height,
                    width: input.intent.source.width,
                  },
          };
        }),
      inspect: () => Effect.succeed(null),
    },
    currentAuthorization: (authorization) => Effect.succeed(authorization),
    executionLimits: (artifactRequest) => ({
      computeMilliseconds: 30_000,
      maximumOutputBytes:
        options.maximumOutputBytes ??
        (artifactRequest.intent._tag === "Presentation" ? 10_000_000n : 5_000_000n),
      modelSteps: artifactRequest.intent._tag === "Image" ? 1n : 0n,
    }),
    validator: {
      validate: (contentId, intent, bytes, inspection, sourceContentId) => {
        if (inspection._tag === "Presentation") {
          if (inspection.issues.length > 0) {
            return DocumentArtifact.invalid(
              contentId,
              "visualInspectionFailed",
              "Presentation visual inspection failed",
            );
          }
          return DocumentArtifact.makePresentation(
            contentId,
            bytes.byteLength,
            inspection.renderedSlideCount,
            "a".repeat(64),
            sourceContentId,
          );
        }
        return DocumentArtifact.makeVisual(
          contentId,
          intent._tag === "Image" ? "image" : "diagram",
          bytes.byteLength,
          inspection.width,
          inspection.height,
          "a".repeat(64),
          sourceContentId,
        );
      },
    },
  });
  return {
    computations: () => computations,
    disposals: () => disposals,
    recordedCosts: () => recordedCosts,
    retained,
    service,
  };
};
