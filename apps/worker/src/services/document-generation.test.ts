/* oxlint-disable vitest/no-standalone-expect, effecttsgo/global-date -- Assertions and fixed timestamps belong to isolated Effect fixtures. */
import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
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
import { FileId } from "../domain/file";
import { FileDigest } from "../domain/file-content";
import type { PdfFormSource } from "../domain/pdf-form";
import { DocumentGeneration } from "./document-generation";
const source = {
  templateFileId: FileId.make("template"),
  templateDigest: FileDigest.make(`sha256:${"a".repeat(64)}`),
  pageCount: 1,
  fields: [{ kind: "text", name: "ApplicantName", value: "Example Applicant" }],
} satisfies PdfFormSource;

it("rejects a source that mixes a template with replacement pages", () => {
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(DocumentGeneration.GenerationSource)({
        ...source,
        pages: [{ title: "Replacement", lines: [] }],
      }),
    ),
  ).toBe(true);
});

it.effect("retains and replays one form artifact through existing accounting and export", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const artifact = yield* fixture.service.generate(request());
    expect(fixture.retained).toHaveLength(1);
    expect(fixture.retained[0]).toMatchObject({
      retention: "accounted",
      cost: { _tag: "ProvenNoUse" },
    });
    const replay = yield* fixture.service.generate(request());
    expect(replay).toEqual(artifact);
    expect(fixture.fills()).toBe(1);
    expect(new Set(fixture.accountingSources).size).toBe(1);
    const exported = yield* fixture.service.export({
      actionId: request().actionId,
      authorization: request().authorization,
      contentId: artifact.content.contentId,
    });
    expect(exported.bytes).toEqual(new Uint8Array([1, 2, 3]));
    const conflict = yield* fixture.service
      .generate({
        ...request(),
        source: { ...source, templateDigest: FileDigest.make(`sha256:${"b".repeat(64)}`) },
      })
      .pipe(Effect.result);
    expect(conflict).toMatchObject({ failure: { _tag: "DocumentIntentConflict" } });
    expect(fixture.fills()).toBe(1);
  }),
);

it.effect("retains Sandbox form cost and replays without another render", () =>
  Effect.gen(function* () {
    const fixture = makeFixture(false, true);
    const artifact = yield* fixture.service.generate(request());
    expect(fixture.retained[0]?.cost).toMatchObject({
      _tag: "Incurred",
      providerOperationId: "sandbox:form-test",
      usdMicros: 50_000n,
    });
    expect(yield* fixture.service.generate(request())).toEqual(artifact);
    expect(fixture.computes()).toBe(1);
    expect(fixture.fills()).toBe(1);
    expect(fixture.cleanups()).toBe(2);
  }),
);

it.effect("denies a form before reading its private template when authority ends", () =>
  Effect.gen(function* () {
    const fixture = makeFixture(true);
    expect(yield* fixture.service.generate(request()).pipe(Effect.result)).toMatchObject({
      failure: { _tag: "Denied", reason: "authorityRevoked" },
    });
    expect(fixture.fills()).toBe(0);
    expect(fixture.retained).toHaveLength(0);
  }),
);

const makeFixture = (revoked = false, sandbox = false) => {
  let computes = 0;
  let cleanups = 0;
  const retained: Array<DocumentGeneration.StoredArtifact> = [];
  const accountingSources: Array<string> = [];
  let fills = 0;
  const service = DocumentGeneration.make({
    allowances: {
      record: (_period, usageSource) =>
        Effect.sync(() => {
          accountingSources.push(usageSource.sourceId);
          return { _tag: "Recorded" as const };
        }),
    },
    artifacts: {
      account: (id) =>
        Effect.sync(() => {
          const index = retained.findIndex((x) => x.artifact.content.contentId === id);
          const item = retained[index];
          if (item !== undefined) retained[index] = { ...item, retention: "accounted" };
        }),
      delete: () => Effect.void,
      inspect: (id) =>
        Effect.sync(() => retained.find((x) => x.artifact.content.contentId === id) ?? null),
      put: (item) =>
        Effect.sync(() => {
          retained.push(item);
        }),
      readBytes: () => Effect.succeed(new Uint8Array([1, 2, 3])),
    },
    artifactValidator: {
      validate: (id, format, bytes, pages) =>
        DocumentArtifact.make(id, format, bytes.length, pages, "a".repeat(64)),
    },
    authorization: {
      admit: () => ({
        _tag: "Admitted",
        allowancePeriod: { _tag: "Metered", allowancePeriodId, grantSource: null },
        capabilityCatalogVersion,
        executionMode: "normalPlanUsage",
        manifestVersion: null,
      }),
      recheck: () =>
        revoked
          ? { _tag: "Denied", reason: "authorityRevoked", resetAt: null }
          : { _tag: "Permitted" },
    },
    compute: {
      dispose: () =>
        Effect.sync(() => {
          cleanups += 1;
        }),
      inspect: () => Effect.succeed(null),
      generate: (input) =>
        Effect.gen(function* () {
          if (!sandbox) return yield* Effect.die(new Error("Local form must not start Sandbox"));
          yield* input.authorizeWrite;
          computes += 1;
          expect(input.source).toMatchObject({ ...source, templateBytes: new Uint8Array([4, 5]) });
          return {
            _tag: "Completed" as const,
            bytes: new Uint8Array([1, 2, 3]),
            renderedPageCount: 1,
            cost: {
              _tag: "Incurred" as const,
              allowancePeriodId,
              basis: "conservative" as const,
              providerOperationId: "sandbox:form-test",
              usdMicros: 50_000n,
            },
          };
        }).pipe(Effect.orDie),
    },
    currentAuthorization: () => Effect.succeed(request().authorization),
    maximumComputeInputBytes: 5_000_000,
    visuals: { read: () => Effect.die(new Error("Form must not read visuals")) },
    pdfForms: {
      prepare: () =>
        Effect.sync(() => {
          fills += 1;
          return sandbox
            ? { templateBytes: new Uint8Array([4, 5]) }
            : { bytes: new Uint8Array([1, 2, 3]), renderedPageCount: 1 };
        }),
    },
  });
  return {
    service,
    retained,
    accountingSources,
    fills: () => fills,
    computes: () => computes,
    cleanups: () => cleanups,
  };
};
const userId = UserId.make("user-artifact");
const allowancePeriodId = AllowancePeriodId.make("allowance-artifact");
const planPolicyVersion = PlanPolicyVersion.make("shared-usage-v1");
const capabilityCatalogVersion = CapabilityCatalogVersion.make("governed-capabilities-v1");
const channelLinkId = ChannelLinkId.make("link-1");
const channelAddress = {
  authorId: ChannelAuthorId.make("author-1"),
  channelId: ChannelId.make("channel-1"),
};

const request = () => ({
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
  format: "pdf" as const,
  source,
  owner: { _tag: "ToolCall" as const, toolCallId: "tool-artifact" },
});
