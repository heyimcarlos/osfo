import { describe, expect, it } from "@effect/vitest";

import { qualificationChecksum } from "./qualification-checksum";
import {
  assessSemanticEvidence,
  type ProductAuthorityExport,
  type RootSemanticTrace,
  type SemanticEvidenceInput,
  type SemanticJourneyRequirement,
} from "./semantic-evidence";
import { r2ObjectEvidence } from "./r2-object-evidence";

const componentAuthority = {
  PostgreSQL: "allowance_and_billing_ledger",
  Provider: "provider_delivery_receipts",
  Think: "think_submission_receipts",
  WhatsApp: "whatsapp_delivery_receipts",
} as const;

const authorityExport = (
  authority: ProductAuthorityExport["authority"],
  records: ProductAuthorityExport["records"],
): ProductAuthorityExport => {
  const artifactId = `unit-${authority}`;
  const exportedAtUtc = "2026-08-17T13:00:00.000Z";
  const sourceVersion = "qualification-export-v1";
  return {
    artifactId,
    authority,
    checksum: qualificationChecksum({
      artifactId,
      authority,
      exportedAtUtc,
      records,
      sourceVersion,
    }),
    exportedAtUtc,
    records,
    sourceVersion,
  };
};

type UnitAuthority =
  | "provider_delivery_receipts"
  | "think_submission_receipts"
  | "whatsapp_delivery_receipts";

const isUnitAuthority = (
  authority: ProductAuthorityExport["authority"],
): authority is UnitAuthority =>
  authority === "provider_delivery_receipts" ||
  authority === "think_submission_receipts" ||
  authority === "whatsapp_delivery_receipts";

const authorityRecord = (
  authority: UnitAuthority,
  suffix: string,
): ProductAuthorityExport["records"][number] => {
  const base = {
    occurredAt: "2026-08-17T12:00:00.010Z",
    productFactId:
      authority === "provider_delivery_receipts"
        ? `outcome-${suffix}`
        : `${authority}-fact-${suffix}`,
    rootId: `message-${suffix}`,
    stageOccurrences: [],
    usageFacts: [],
  };
  switch (authority) {
    case "think_submission_receipts":
      return {
        ...base,
        acceptanceReceiptId: `receipt-${suffix}`,
        submissionStatus: "accepted",
        thinkSubmissionId: `submission-${suffix}`,
      };
    case "provider_delivery_receipts":
      return {
        ...base,
        deliveryId: `delivery-${suffix}`,
        outcomeId: `outcome-${suffix}`,
        providerStatus: "succeeded",
      };
    case "whatsapp_delivery_receipts":
      return {
        ...base,
        deliveryId: `delivery-${suffix}`,
        outcomeId: `outcome-${suffix}`,
        providerMessageId: `provider-message-${suffix}`,
        deliveryStatus: "succeeded",
        userMessageId: `message-${suffix}`,
        userUpdateId: `update-${suffix}`,
      };
  }
  return {
    ...base,
    acceptanceReceiptId: `receipt-${suffix}`,
    submissionStatus: "accepted",
    thinkSubmissionId: `submission-${suffix}`,
  };
};

describe("Semantic evidence", () => {
  it("requires exactly one unsampled trace for every accepted root", () => {
    const input = semanticEvidenceInput();
    expect(
      assessSemanticEvidence(
        {
          ...input,
          localEvidence: [],
          productAuthorityExports: [],
          r2Evidence: [],
          traces: [],
        },
        requirements,
      ),
    ).toMatchObject({
      findings: [{ code: "rootTraceMissing", subject: "message-1", verdict: "MISSING" }],
      verdict: "MISSING",
    });
    expect(
      assessSemanticEvidence(
        { ...input, traces: [...input.traces, { ...input.traces[0], traceId: "duplicate" }] },
        requirements,
      ),
    ).toMatchObject({
      findings: [{ code: "duplicateRootTrace", subject: "message-1", verdict: "FAIL" }],
      verdict: "FAIL",
    });
  });

  it("checks required stages and components on each accepted root", () => {
    const input = semanticEvidenceInput();
    const second = {
      ...input.traces[0],
      rootId: "message-2",
      traceId: "trace-2",
      correlations: {
        ...input.traces[0].correlations,
        acceptanceReceiptId: "receipt-2",
        allowanceConsumptionId: "allowance-2",
        costReconciliationId: "cost-2",
        deliveryId: "delivery-2",
        outcomeId: "outcome-2",
        thinkRequestId: "request-2",
        thinkSubmissionId: "submission-2",
        userMessageId: "message-2",
        userUpdateId: "update-2",
      },
      costReconciliationId: "cost-2",
      signals: [],
    };
    const localEvidence = [
      ...input.localEvidence,
      ...input.localEvidence.map((entry) =>
        entry.store === "AgentSQLite"
          ? {
              ...entry,
              acceptanceReceiptId: "receipt-2",
              evidenceId: `${entry.evidenceId}-2`,
              productFactId: "assistant-2",
              rootId: "message-2",
              thinkRequestId: "request-2",
            }
          : {
              ...entry,
              acceptanceReceiptId: "receipt-2",
              allowanceConsumptionId: "allowance-2",
              evidenceId: `${entry.evidenceId}-2`,
              productFactId: "allowance-2",
            },
      ),
    ];
    expect(
      assessSemanticEvidence(
        {
          ...input,
          acceptedRootIds: ["message-1", "message-2"],
          localEvidence,
          productAuthorityExports: input.productAuthorityExports.map((artifact) => {
            if (!isUnitAuthority(artifact.authority)) return artifact;
            const records = [...artifact.records, authorityRecord(artifact.authority, "2")];
            return authorityExport(artifact.authority, records);
          }),
          traces: [input.traces[0], second],
        },
        requirements,
      ),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "componentEvidenceMissing", subject: "message-2:Think" }),
      ]),
      verdict: "MISSING",
    });
  });

  it("uses manifest-owned amplification maxima", () => {
    const input = semanticEvidenceInput();
    const trace = { ...input.traces[0], amplification: [{ count: 2, kind: "thinkSubmissions" }] };
    expect(assessSemanticEvidence({ ...input, traces: [trace] }, requirements)).toEqual({
      findings: [
        {
          code: "amplificationExceeded",
          detail: "message-1 produced 2 thinkSubmissions, maximum 1",
          subject: "message-1",
          verdict: "FAIL",
        },
      ],
      verdict: "FAIL",
    });
  });

  it("requires the product fact and evidence in the same local transaction", () => {
    const input = semanticEvidenceInput();
    const localEvidence = input.localEvidence.map((entry, index) =>
      index === 0 ? { ...entry, thinkRequestId: "other-request" } : entry,
    );
    expect(assessSemanticEvidence({ ...input, localEvidence }, requirements)).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "localProductEvidenceConflict", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("does not use telemetry as product authority", () => {
    const input = semanticEvidenceInput();
    expect(
      assessSemanticEvidence(
        {
          ...input,
          localEvidence: input.localEvidence.filter((entry) => entry.store !== "AgentSQLite"),
          telemetry: [
            {
              observedAt: "2026-08-17T12:00:00.100Z",
              rootId: "message-1",
              signal: "agent.sqlite.transaction.committed",
              store: "AgentSQLite",
            },
          ],
        },
        requirements,
      ),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "localEvidenceMissing", verdict: "MISSING" }),
      ]),
      verdict: "MISSING",
    });
  });

  it("returns MISSING when a component has telemetry but no committed product fact", () => {
    const input = semanticEvidenceInput();
    expect(
      assessSemanticEvidence({ ...input, productAuthorityExports: [] }, requirements),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "componentProductAuthorityMissing", verdict: "MISSING" }),
      ]),
      verdict: "MISSING",
    });
  });

  it("rejects a component export whose checksum does not match its retained records", () => {
    const input = semanticEvidenceInput();
    expect(
      assessSemanticEvidence(
        {
          ...input,
          productAuthorityExports: input.productAuthorityExports.map((artifact, index) =>
            index === 0
              ? Object.assign({}, artifact, {
                  checksum: `sha256:${"0".repeat(64)}`,
                })
              : artifact,
          ),
        },
        requirements,
      ),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: "productAuthorityExportChecksumMismatch",
          verdict: "FAIL",
        }),
      ]),
      verdict: "FAIL",
    });
  });

  it("accepts a failed provider receipt as a committed terminal fact", () => {
    const input = semanticEvidenceInput();
    const productAuthorityExports = input.productAuthorityExports.map((artifact) => {
      if (artifact.authority !== "provider_delivery_receipts") return artifact;
      const records = artifact.records.map((record) =>
        "providerStatus" in record ? { ...record, providerStatus: "failed" as const } : record,
      );
      return authorityExport(artifact.authority, records);
    });
    expect(assessSemanticEvidence({ ...input, productAuthorityExports }, requirements)).toEqual({
      findings: [],
      verdict: "PASS",
    });
  });

  it("rejects duplicate local product authority for one root", () => {
    const input = semanticEvidenceInput();
    const duplicate = input.localEvidence[0];
    expect(duplicate).toBeDefined();
    if (duplicate === undefined) return;
    expect(
      assessSemanticEvidence(
        { ...input, localEvidence: [...input.localEvidence, duplicate] },
        requirements,
      ),
    ).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "duplicateLocalAuthorityEvidence", verdict: "FAIL" }),
      ]),
      verdict: "FAIL",
    });
  });

  it("rejects inconsistent activation causes and malformed material values", () => {
    const input = semanticEvidenceInput();
    const trace = {
      ...input.traces[0],
      activation: { ...input.traces[0].activation, cause: "warm" as const },
      resourceUse: [{ name: "cpu", quantity: -1, unit: "ms" }],
    };
    expect(assessSemanticEvidence({ ...input, traces: [trace] }, requirements)).toMatchObject({
      findings: [
        expect.objectContaining({ code: "activationClassificationConflict" }),
        expect.objectContaining({ code: "invalidTraceEvidence" }),
      ],
      verdict: "FAIL",
    });
  });

  it("derives R2 evidence only from committed object metadata", () => {
    expect(
      r2ObjectEvidence({
        checksums: { toJSON: () => ({ sha256: "sha256:object-1" }) },
        customMetadata: { osfoObjectId: "object-1", osfoRootId: "message-1" },
        etag: "etag-1",
        key: "qualification/message-1",
        uploaded: { toISOString: () => "2026-08-17T12:00:00.000Z" },
        version: "version-1",
      }),
    ).toEqual({
      checksum: "sha256:object-1",
      etag: "etag-1",
      objectId: "object-1",
      objectKey: "qualification/message-1",
      rootId: "message-1",
      uploadedAt: "2026-08-17T12:00:00.000Z",
      version: "version-1",
    });
    expect(
      r2ObjectEvidence({
        checksums: { toJSON: () => ({ sha256: "sha256:object-1" }) },
        etag: "etag-1",
        key: "qualification/message-1",
        uploaded: { toISOString: () => "2026-08-17T12:00:00.000Z" },
        version: "version-1",
      }),
    ).toBeNull();
  });
});

const requirements = {
  ordinaryConversation: {
    amplificationLimits: { thinkSubmissions: 1 },
    requiredComponents: ["Think", "PostgreSQL", "Provider", "WhatsApp"],
    requiredCorrelations: [
      "acceptanceReceiptId",
      "allowanceConsumptionId",
      "deliveryId",
      "outcomeId",
      "thinkRequestId",
      "thinkSubmissionId",
      "userMessageId",
      "userUpdateId",
    ],
    requiredStages: [
      "durableAcceptance",
      "thinkSubmissionAccepted",
      "terminalOutcome",
      "resourceUseReconciled",
      "costReconciled",
    ],
    requiredStores: ["PostgreSQL", "AgentSQLite"],
  },
} satisfies Readonly<Record<string, SemanticJourneyRequirement>>;

const semanticEvidenceInput = (): SemanticEvidenceInput & {
  readonly traces: readonly [RootSemanticTrace];
} => ({
  acceptedRootIds: ["message-1"],
  localEvidence: [
    {
      acceptanceReceiptId: "receipt-1",
      authority: "osfo_committed_turns",
      evidenceId: "agent-sqlite:receipt-1",
      occurredAt: "2026-08-17T12:00:00.010Z",
      productFactId: "assistant-1",
      rootId: "message-1",
      store: "AgentSQLite",
      thinkRequestId: "request-1",
    },
    {
      acceptanceReceiptId: "receipt-1",
      allowanceConsumptionId: "allowance-1",
      authority: "allowance_usage",
      evidenceId: "postgres:allowance-1",
      occurredAt: "2026-08-17T12:00:00.010Z",
      productFactId: "allowance-1",
      store: "PostgreSQL",
    },
  ],
  productAuthorityExports: (
    [
      "think_submission_receipts",
      "provider_delivery_receipts",
      "whatsapp_delivery_receipts",
    ] as const
  ).map((authority) => authorityExport(authority, [authorityRecord(authority, "1")])),
  r2Evidence: [],
  telemetry: [],
  traces: [
    {
      activation: {
        activationId: "activation-1",
        cause: "firstUse",
        classification: "cold",
        region: "americas",
      },
      ambiguity: "none",
      amplification: [{ count: 1, kind: "thinkSubmissions" }],
      correlations: {
        acceptanceReceiptId: "receipt-1",
        allowanceConsumptionId: "allowance-1",
        costReconciliationId: "cost-1",
        deliveryId: "delivery-1",
        outcomeId: "outcome-1",
        priceBookId: "price-book-v1",
        r2ObjectId: null,
        scheduledTaskId: null,
        thinkRequestId: "request-1",
        thinkSubmissionId: "submission-1",
        userMessageId: "message-1",
        userUpdateId: "update-1",
        workflowId: null,
      },
      costReconciliationId: "cost-1",
      journey: "ordinaryConversation",
      operations: (
        [
          "modelStep",
          "tool",
          "search",
          "memory",
          "file",
          "workflowStep",
          "retry",
          "delivery",
          "providerCall",
          "cost",
        ] as const
      ).map((kind) => ({
        kind,
        maximum: 1,
        p50: 1,
        p95: 1,
        p99: 1,
        sampleCount: 1,
        samples: [1],
        sourceProductFactIds: ["outcome-1"],
      })),
      plan: "free",
      resourceUse: [{ name: "cpu", quantity: 1, unit: "ms" }],
      retries: [],
      rootId: "message-1",
      signals: (["Think", "PostgreSQL", "Provider", "WhatsApp"] as const).map((component) => ({
        component,
        occurredAt: "2026-08-17T12:00:00.010Z",
        signalId:
          component === "Provider"
            ? "outcome-1"
            : component === "PostgreSQL"
              ? "allowance-1"
              : `${componentAuthority[component]}-fact-1`,
      })),
      stages:
        requirements.ordinaryConversation?.requiredStages.map((stage) => ({
          occurredAt: "2026-08-17T12:00:00.010Z",
          stage,
        })) ?? [],
      stageOccurrences: [],
      terminalState: "succeeded",
      traceId: "trace-1",
    },
  ],
});
