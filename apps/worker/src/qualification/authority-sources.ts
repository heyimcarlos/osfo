import type {
  FaultInjection,
  ProductionQualificationManifest,
  ReferenceJourney,
} from "./qualification-manifest";
import type { SemanticComponent } from "./semantic-evidence";

/** Product-owned authorities that must contribute immutable material before qualification can pass. */
export const qualificationAuthoritySources = [
  "allowance_and_billing_ledger",
  "gmail_provider_receipts",
  "memory_commit_receipts",
  "model_access_receipts",
  "osfo_agent_activation_log",
  "osfo_committed_turns",
  "provider_delivery_receipts",
  "qualification_fault_controller_receipts",
  "r2_object_metadata",
  "task_compute_receipts",
  "think_submission_receipts",
  "whatsapp_delivery_receipts",
  "worker_admission_receipts",
  "workflow_instance_receipts",
] as const;

export type QualificationAuthoritySource = (typeof qualificationAuthoritySources)[number];

export const qualificationReferenceJourneys = [
  "accountBillingSafetyDataRights",
  "documentBuild",
  "fileAnalysis",
  "gmail",
  "ordinaryConversation",
  "registration",
  "reminder",
  "researchReport",
  "scheduledEmail",
] as const satisfies ReadonlyArray<ReferenceJourney>;

const allJourneys = qualificationReferenceJourneys;

export type QualificationAuthorityAdapterRequirement =
  | "allowanceTables"
  | "artifactBucket"
  | "attemptIndexTable"
  | "directoryBinding"
  | "postgresBinding"
  | "scheduledEmailTable";

/**
 * One source adapter installed in the private product-authority Worker.
 * Coverage names only journeys whose required component the adapter can prove end to end.
 */
export const qualificationAuthorityAdapterRegistry = [
  {
    component: "PostgreSQL",
    journeys: allJourneys,
    mode: "agentPostgresCollector",
    requirements: [
      "allowanceTables",
      "artifactBucket",
      "attemptIndexTable",
      "directoryBinding",
      "postgresBinding",
    ],
    source: "allowance_and_billing_ledger",
  },
  {
    component: "Gmail",
    journeys: ["scheduledEmail"],
    mode: "agentPostgresCollector",
    requirements: ["artifactBucket", "attemptIndexTable", "postgresBinding", "scheduledEmailTable"],
    source: "gmail_provider_receipts",
  },
  {
    component: "Memory",
    journeys: ["ordinaryConversation"],
    mode: "agentPostgresCollector",
    requirements: ["artifactBucket", "attemptIndexTable", "directoryBinding", "postgresBinding"],
    source: "memory_commit_receipts",
  },
  {
    component: "ModelAccess",
    journeys: allJourneys,
    mode: "agentPostgresCollector",
    requirements: [
      "allowanceTables",
      "artifactBucket",
      "attemptIndexTable",
      "directoryBinding",
      "postgresBinding",
    ],
    source: "model_access_receipts",
  },
  {
    activationCauses: ["deployment", "faultRecovery", "firstUse", "warm"],
    component: "AgentActivation",
    journeys: allJourneys,
    mode: "agentPostgresCollector",
    requirements: ["artifactBucket", "attemptIndexTable", "directoryBinding", "postgresBinding"],
    source: "osfo_agent_activation_log",
  },
  {
    component: "FaultController",
    faultKinds: ["coldActivation"],
    journeys: [],
    mode: "controlledAgentFaultReadback",
    requirements: ["artifactBucket", "directoryBinding"],
    source: "qualification_fault_controller_receipts",
  },
  {
    component: "AgentSQLite",
    journeys: allJourneys,
    mode: "agentPostgresCollector",
    requirements: ["artifactBucket", "attemptIndexTable", "directoryBinding", "postgresBinding"],
    source: "osfo_committed_turns",
  },
  {
    component: "Provider",
    journeys: ["scheduledEmail"],
    mode: "agentPostgresCollector",
    requirements: ["artifactBucket", "attemptIndexTable", "postgresBinding", "scheduledEmailTable"],
    source: "provider_delivery_receipts",
  },
  {
    component: "R2",
    journeys: ["documentBuild"],
    mode: "documentR2ObjectReadback",
    requirements: ["artifactBucket", "attemptIndexTable", "postgresBinding"],
    source: "r2_object_metadata",
  },
  {
    component: "TaskCompute",
    journeys: ["scheduledEmail"],
    mode: "agentPostgresCollector",
    requirements: ["artifactBucket", "attemptIndexTable", "postgresBinding", "scheduledEmailTable"],
    source: "task_compute_receipts",
  },
  {
    component: "Think",
    journeys: allJourneys,
    mode: "arrivalReadback",
    requirements: ["artifactBucket"],
    source: "think_submission_receipts",
  },
  {
    component: "Worker",
    journeys: allJourneys,
    mode: "arrivalReadback",
    requirements: ["artifactBucket"],
    source: "worker_admission_receipts",
  },
  {
    component: "Workflow",
    journeys: ["scheduledEmail"],
    mode: "agentPostgresCollector",
    requirements: ["artifactBucket", "attemptIndexTable", "postgresBinding", "scheduledEmailTable"],
    source: "workflow_instance_receipts",
  },
] as const satisfies ReadonlyArray<{
  readonly component: SemanticComponent | "FaultController";
  readonly activationCauses?: ReadonlyArray<
    "deployment" | "faultRecovery" | "firstUse" | "idleEviction" | "warm"
  >;
  readonly faultKinds?: ReadonlyArray<FaultInjection["kind"]>;
  readonly journeys: ReadonlyArray<ReferenceJourney>;
  readonly mode:
    | "agentPostgresCollector"
    | "arrivalReadback"
    | "controlledAgentFaultReadback"
    | "documentR2ObjectReadback";
  readonly requirements: ReadonlyArray<QualificationAuthorityAdapterRequirement>;
  readonly source: QualificationAuthoritySource;
}>;

export type QualificationAuthorityAdapter = (typeof qualificationAuthorityAdapterRegistry)[number];
export type QualificationInstalledAuthoritySource = QualificationAuthorityAdapter["source"];
export type QualificationAgentPostgresAuthoritySource = Extract<
  QualificationAuthorityAdapter,
  { readonly mode: "agentPostgresCollector" }
>["source"];
export type QualificationArrivalReadbackAuthoritySource = Extract<
  QualificationAuthorityAdapter,
  { readonly mode: "arrivalReadback" }
>["source"];
export type QualificationControlledAgentFaultAuthoritySource = Extract<
  QualificationAuthorityAdapter,
  { readonly mode: "controlledAgentFaultReadback" }
>["source"];
export type QualificationDocumentR2ObjectAuthoritySource = Extract<
  QualificationAuthorityAdapter,
  { readonly mode: "documentR2ObjectReadback" }
>["source"];

export const qualificationAgentPostgresAuthoritySources = qualificationAuthorityAdapterRegistry
  .filter(({ mode }) => mode === "agentPostgresCollector")
  .map(({ source }) => source);

export const qualificationArrivalReadbackAuthoritySources = qualificationAuthorityAdapterRegistry
  .filter(({ mode }) => mode === "arrivalReadback")
  .map(({ source }) => source);

export const isQualificationInstalledAuthoritySource = (
  source: QualificationAuthoritySource,
): source is QualificationInstalledAuthoritySource =>
  qualificationAuthorityAdapterRegistry.some((adapter) => adapter.source === source);

export const isQualificationAgentPostgresAuthoritySource = (
  source: QualificationAuthoritySource,
): source is QualificationAgentPostgresAuthoritySource =>
  qualificationAuthorityAdapterRegistry.some(
    (adapter) => adapter.source === source && adapter.mode === "agentPostgresCollector",
  );

export const isQualificationArrivalReadbackAuthoritySource = (
  source: QualificationAuthoritySource,
): source is QualificationArrivalReadbackAuthoritySource =>
  qualificationAuthorityAdapterRegistry.some(
    (adapter) => adapter.source === source && adapter.mode === "arrivalReadback",
  );

export const isQualificationControlledAgentFaultAuthoritySource = (
  source: QualificationAuthoritySource,
): source is QualificationControlledAgentFaultAuthoritySource =>
  qualificationAuthorityAdapterRegistry.some(
    (adapter) => adapter.source === source && adapter.mode === "controlledAgentFaultReadback",
  );

export const isQualificationDocumentR2ObjectAuthoritySource = (
  source: QualificationAuthoritySource,
): source is QualificationDocumentR2ObjectAuthoritySource =>
  qualificationAuthorityAdapterRegistry.some(
    (adapter) => adapter.source === source && adapter.mode === "documentR2ObjectReadback",
  );

export const qualificationAuthorityAdapterFor = (source: QualificationAuthoritySource) =>
  qualificationAuthorityAdapterRegistry.find((adapter) => adapter.source === source);

export const qualificationAuthoritySourcesRequiring = (
  requirement: QualificationAuthorityAdapterRequirement,
): ReadonlyArray<QualificationInstalledAuthoritySource> =>
  qualificationAuthorityAdapterRegistry.flatMap((adapter) =>
    adapter.requirements.some((required) => required === requirement) ? [adapter.source] : [],
  );

export interface QualificationAuthorityCoverageGap {
  readonly activationCause?: "faultRecovery" | "idleEviction";
  readonly component: SemanticComponent | "FaultController";
  readonly faultKind?: FaultInjection["kind"];
  readonly faultScope?: "allCold";
  readonly journey: ReferenceJourney | null;
  readonly source: QualificationAuthoritySource;
}

const sourceComponents = {
  allowance_and_billing_ledger: "PostgreSQL",
  gmail_provider_receipts: "Gmail",
  memory_commit_receipts: "Memory",
  model_access_receipts: "ModelAccess",
  osfo_agent_activation_log: "AgentActivation",
  osfo_committed_turns: "AgentSQLite",
  provider_delivery_receipts: "Provider",
  r2_object_metadata: "R2",
  task_compute_receipts: "TaskCompute",
  think_submission_receipts: "Think",
  whatsapp_delivery_receipts: "WhatsApp",
  worker_admission_receipts: "Worker",
  workflow_instance_receipts: "Workflow",
} as const satisfies Partial<Record<QualificationAuthoritySource, SemanticComponent>>;

/** Exact unsupported producer pairs in canonical source then frozen journey order. */
export const qualificationAuthorityCoverageGaps = (
  manifest: ProductionQualificationManifest,
): ReadonlyArray<QualificationAuthorityCoverageGap> => {
  const gaps = new Array<QualificationAuthorityCoverageGap>();
  for (const source of qualificationAuthoritySources) {
    if (source === "qualification_fault_controller_receipts") {
      const adapter = qualificationAuthorityAdapterFor(source);
      const coveredKinds =
        adapter !== undefined && "faultKinds" in adapter ? adapter.faultKinds : [];
      for (const { kind: faultKind } of manifest.faults) {
        if (!coveredKinds.some((coveredKind) => coveredKind === faultKind)) {
          gaps.push({ component: "FaultController", faultKind, journey: null, source });
        }
      }
      if (manifest.lanes.some(({ kind }) => kind === "allCold")) {
        gaps.push({
          component: "FaultController",
          faultKind: "coldActivation",
          faultScope: "allCold",
          journey: null,
          source,
        });
      }
      continue;
    }
    const component = sourceComponents[source];
    if (component === undefined) continue;
    if (source === "osfo_agent_activation_log") {
      const adapter = qualificationAuthorityAdapterFor(source);
      const coveredCauses =
        adapter !== undefined && "activationCauses" in adapter ? adapter.activationCauses : [];
      const coveredCauseSet = new Set<string>(coveredCauses);
      for (const activationCause of ["idleEviction", "faultRecovery"] as const) {
        if (!coveredCauseSet.has(activationCause)) {
          gaps.push({ activationCause, component, journey: null, source });
        }
      }
    }
    const coveredJourneys = qualificationAuthorityAdapterFor(source)?.journeys ?? [];
    for (const { journey, percentage } of manifest.journeyMix) {
      if (
        percentage > 0 &&
        manifest.semanticRequirements[journey].requiredComponents.includes(component) &&
        !coveredJourneys.some((coveredJourney) => coveredJourney === journey)
      ) {
        gaps.push({ component, journey, source });
      }
    }
  }
  return gaps;
};

export const isQualificationAuthoritySource = (
  value: string,
): value is QualificationAuthoritySource =>
  qualificationAuthoritySources.some((source) => source === value);
