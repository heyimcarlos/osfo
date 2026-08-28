/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect tests. */
/* oxlint-disable effecttsgo/global-date -- Fixed accounting dates are deterministic evidence. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AgentId,
  AllowancePeriodId,
  CapabilityCatalogVersion,
  ConversationRouteId,
  ModelAccessPolicyVersion,
  PlanPolicyVersion,
  ResourcePriceVersion,
  SessionId,
  UserId,
} from "../domain";
import { ActionId } from "../domain/action-execution";
import { AuthSessionId } from "../domain/auth-session";
import { ContentId } from "../domain/client-content";
import { DocumentArtifact } from "../domain/document-artifact";
import { FileDigest } from "../domain/file-content";
import { FileId } from "../domain/file";
import { ManagedModelRoute } from "../domain/model-access-policy";
import { DocumentBuild } from "./document-build";
import { DocumentBuildAccounting } from "./document-build-accounting";

it.effect("builds launch-v1 generated-document and provider-cost facts", () =>
  Effect.gen(function* () {
    const accounting = yield* DocumentBuildAccounting.usefulDocumentAccountingFor(
      buildRecord("launch-v1"),
      artifact,
      renderCost,
    );

    expect(accounting).toMatchObject({
      _tag: "Launch",
      facts: [
        { items: [{ allowanceKind: "vendorUsdMicros", quantity: 25n }] },
        { items: [{ allowanceKind: "generatedDocuments", quantity: 1n }] },
      ],
    });
  }),
);

it.effect("builds one final shared Usage Event from pinned publication evidence", () =>
  Effect.gen(function* () {
    const accounting = yield* DocumentBuildAccounting.usefulDocumentAccountingFor(
      buildRecord("shared-usage-v1"),
      artifact,
      renderCost,
    );

    expect(accounting).toMatchObject({
      _tag: "Shared",
      event: {
        evidenceReferences: [
          { kind: "operationEvidence", reference: contentId },
          { kind: "companyCost", reference: renderCost.providerOperationId },
        ],
        outcome: {
          _tag: "Completed",
          charge: {
            components: [{ activity: "filesAndArtifacts", ratedCostUsdMicros: 25n }],
            planUsageMicros: 25n,
          },
        },
        usagePolicyVersion: "shared-usage-v1",
      },
    });
  }),
);

it.effect("records no User accounting for a shared Workflow start", () =>
  Effect.gen(function* () {
    let writes = 0;
    const accounting = DocumentBuildAccounting.make({
      recordLegacy: () => Effect.sync(() => void (writes += 1)),
      recordUsageEvent: () => Effect.sync(() => void (writes += 1)),
    });
    yield* accounting.recordWorkflowStart(buildRecord("shared-usage-v1"));

    expect(writes).toBe(0);
  }),
);

it.effect("converges exact final accounting replays on stable source identities", () =>
  Effect.gen(function* () {
    const facts = new Set<string>();
    const accounting = DocumentBuildAccounting.make({
      recordLegacy: (_period, source, items) =>
        Effect.sync(() => {
          for (const item of items)
            facts.add(`${source.sourceType}:${source.sourceId}:${item.allowanceKind}`);
        }),
      recordUsageEvent: (event) =>
        Effect.sync(() => void facts.add(`${event.source.sourceType}:${event.source.sourceId}`)),
    });
    const build = buildRecord("launch-v1");
    yield* accounting.recordGeneratedDocument(build, artifact, renderCost);
    yield* accounting.recordGeneratedDocument(build, artifact, renderCost);

    expect([...facts]).toEqual([
      `documentProviderOperation:${renderCost.providerOperationId}:vendorUsdMicros`,
      `documentBuild:${build.workflowId}:generatedDocuments`,
    ]);
  }),
);

const occurredAt = new Date("2026-08-28T12:30:00.000Z");
const contentId = ContentId.make("document:workflow:document-build:accounting");
const artifact = DocumentArtifact.ArtifactRef.make({
  artifactRole: { _tag: "GeneratedDocumentV1", format: "pdf", pageCount: 1 },
  content: {
    byteLength: 100,
    contentId,
    mediaType: "application/pdf",
    sha256: "f".repeat(64),
  },
  lineage: { sourceContentId: null },
});
const renderCost = {
  _tag: "Incurred" as const,
  allowancePeriodId: AllowancePeriodId.make("document-build-period"),
  basis: "observed" as const,
  providerOperationId: "document-build-render-operation",
  usdMicros: 25n,
};

const buildRecord = (policy: "launch-v1" | "shared-usage-v1"): DocumentBuild.Record => ({
  acceptedAt: occurredAt,
  accountingCommittedAt: occurredAt,
  actionId: ActionId.make("document-build-accounting-action"),
  admittedAt: occurredAt,
  agentId: AgentId.make("document-build-agent"),
  allowancePeriodId: renderCost.allowancePeriodId,
  artifactAccountedAt: null,
  artifactContentId: contentId,
  cancelRequestedAt: null,
  capabilityCatalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
  cloudflareInstanceId: DocumentBuild.CloudflareInstanceId.make("document-build-accounting"),
  cloudflareTimerInstanceId: DocumentBuild.CloudflareInstanceId.make(
    "document-build-accounting-timer",
  ),
  costEvidence: renderCost,
  deadlineAt: new Date("2026-08-28T13:00:00.000Z"),
  inputDigest: DocumentBuild.InputDigest.make("a".repeat(64)),
  manifestVersion: null,
  modelAccessPolicyVersion: ModelAccessPolicyVersion.make(policy),
  modelRoute: ManagedModelRoute.make("@cf/deepseek-ai/deepseek-v4-flash-0731"),
  originatingAuthority: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("document-build-auth"),
  },
  planPolicyVersion: PlanPolicyVersion.make(policy),
  previewStoredAt: occurredAt,
  publicationCommittedAt: occurredAt,
  request: DocumentBuild.StoredRequest.make({
    fileSnapshots: [
      {
        byteLength: 12n,
        fileId: FileId.make("document-source"),
        mediaType: "text/plain",
        sha256: FileDigest.make(`sha256:${"c".repeat(64)}`),
      },
    ],
    format: "pdf",
    source: { pages: [{ lines: ["hello"], title: "Source" }] },
  }),
  resourcePriceVersion: ResourcePriceVersion.make("resource-prices-2026-08-22"),
  routeId: ConversationRouteId.make("document-build-route"),
  safeFailureCode: null,
  sessionId: SessionId.make("document-build-session"),
  startedAt: occurredAt,
  state: "publication_committed",
  terminalAt: null,
  userId: UserId.make("document-build-user"),
  workflowId: DocumentBuild.WorkflowId.make("document-build:accounting"),
});
