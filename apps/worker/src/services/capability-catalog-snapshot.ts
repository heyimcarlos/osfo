import { Result } from "effect";

import type { CapabilityCatalogVersion } from "../domain";
import {
  CapabilityCatalogNotFound,
  governedCapabilitiesV1Version,
  retainedCapabilityCatalogs,
  resolveCapabilityCatalog,
  type CapabilityCatalog,
  type CapabilityId,
  type GovernedAuthorizationOperationName,
} from "../domain/capability-catalog";
import type {
  AvailabilityFacts,
  AvailabilityRequirement,
  RegisteredToolName,
  ResultBounds,
  TaskKind,
} from "./capabilities";
import { capabilityIntentPolicy } from "./capability-intent-policy";

export interface CatalogEntry {
  readonly availabilityRequirements: ReadonlyArray<AvailabilityRequirement>;
  readonly description: string;
  readonly id: CapabilityId;
  readonly integrationToolkit: "gmail" | "google-calendar" | "google-drive" | null;
  readonly planPolicyOperation: GovernedAuthorizationOperationName;
  readonly resultBounds: ResultBounds;
  readonly skillCandidates: ReadonlyArray<string>;
  readonly taskKinds: ReadonlyArray<TaskKind>;
  readonly toolRequirements: ReadonlyArray<RegisteredToolName>;
}

export interface CatalogSnapshot {
  readonly entries: ReadonlyArray<CatalogEntry>;
  readonly version: CapabilityCatalogVersion;
}

export type MissingAvailability = ReadonlyArray<
  | { readonly _tag: "IntegrationConnection"; readonly toolkit: string }
  | { readonly _tag: "Requirement"; readonly requirement: AvailabilityRequirement }
  | { readonly _tag: "Tool"; readonly toolName: RegisteredToolName }
>;

export const catalogSnapshotsFor = (): ReadonlyArray<CatalogSnapshot> => {
  const governedV1 = resolveCapabilityCatalog(
    retainedCapabilityCatalogs,
    governedCapabilitiesV1Version,
  );
  return Result.isSuccess(governedV1)
    ? [
        {
          entries: governedCapabilitiesV1Entries(governedV1.success),
          version: governedCapabilitiesV1Version,
        },
      ]
    : [];
};

export const resolveCatalog = (
  version: CapabilityCatalogVersion,
  catalogSnapshots: ReadonlyArray<CatalogSnapshot>,
): Result.Result<CatalogSnapshot, CapabilityCatalogNotFound> => {
  const catalog = catalogSnapshots.find((candidate) => candidate.version === version);
  return catalog === undefined
    ? Result.fail(
        new CapabilityCatalogNotFound({
          message: "The active turn names no retained self-serve Capability Catalog",
          version,
        }),
      )
    : Result.succeed(catalog);
};

export const entriesFor = (
  version: CapabilityCatalogVersion,
  catalogSnapshots: ReadonlyArray<CatalogSnapshot>,
): ReadonlyArray<CatalogEntry> => {
  const resolved = resolveCatalog(version, catalogSnapshots);
  return Result.isSuccess(resolved) ? resolved.success.entries : [];
};

export const missingAvailability = (
  capability: CatalogEntry,
  facts: AvailabilityFacts,
): MissingAvailability => {
  const availableRequirements = new Set(facts.availableRequirements);
  const availableToolNames = new Set(facts.availableToolNames);
  const availableIntegrationToolkits = new Set(facts.availableIntegrationToolkits);
  return [
    ...capability.availabilityRequirements
      .filter((requirement) => !availableRequirements.has(requirement))
      .map((requirement) => ({ _tag: "Requirement" as const, requirement })),
    ...(capability.integrationToolkit === null ||
    availableIntegrationToolkits.has(capability.integrationToolkit)
      ? []
      : [{ _tag: "IntegrationConnection" as const, toolkit: capability.integrationToolkit }]),
    ...capability.toolRequirements
      .filter((toolName) => !availableToolNames.has(toolName))
      .map((toolName) => ({ _tag: "Tool" as const, toolName })),
  ];
};

export const capabilityIsAvailable = (
  capability: CatalogEntry,
  input: AvailabilityFacts,
): boolean => missingAvailability(capability, input).length === 0;

export const requirementsFor = (
  capabilityIds: ReadonlyArray<CapabilityId>,
  catalog: ReadonlyArray<CatalogEntry>,
): ReadonlyArray<AvailabilityRequirement> => [
  ...new Set(
    capabilityIds.flatMap(
      (capabilityId) =>
        catalog.find(({ id }) => id === capabilityId)?.availabilityRequirements ?? [],
    ),
  ),
];

const governedCapabilitiesV1Entries = (policyCatalog: CapabilityCatalog) => {
  const entry = catalogEntry(policyCatalog);
  const integrationEntry = catalogIntegrationEntry(policyCatalog);
  const generatedImageResultBounds: ResultBounds = {
    maximumBytes: policyCatalog.operationLimits.generatedImageBytes,
    maximumDurationMillis: policyCatalog.operationLimits.durableArtifactOperationMilliseconds,
    maximumItems: 1,
    maximumPages: null,
    maximumPixelsPerEdge: policyCatalog.operationLimits.generatedImagePixelsPerEdge,
    maximumSlides: null,
  };

  return [
    entry("conversation", "Continue the current personal conversation.", "conversation.run"),
    entry("core-memory", "Update durable Core Memory.", "memory.correct", {
      availabilityRequirements: ["native-memory"],
      toolRequirements: ["set_context"],
    }),
    entry("memory-clear", "Clear selected Core Memory after Approval.", "memory.clear", {
      availabilityRequirements: ["native-memory"],
      toolRequirements: ["osfoClearCoreMemory"],
    }),
    entry(
      "knowledge-forget",
      "Correct Core Memory and forget selected provider Knowledge after Approval.",
      "memory.forgetKnowledge",
      {
        availabilityRequirements: ["native-memory"],
        toolRequirements: ["osfoForgetKnowledge"],
      },
    ),
    entry("session-delete", "Delete an owned Session after Approval.", "session.delete", {
      availabilityRequirements: ["session-history"],
      toolRequirements: ["osfoDeleteSession"],
    }),
    entry("session-recall", "Recall exact text from owned Sessions.", "session.recall", {
      availabilityRequirements: ["session-history"],
      toolRequirements: ["sessionRecall"],
    }),
    entry("file-read", "Read an owned retained file.", "file.read", {
      availabilityRequirements: ["file-storage"],
      resultBounds: {
        maximumBytes: policyCatalog.operationLimits.normalizedTextBytes,
        maximumDurationMillis: policyCatalog.operationLimits.interactiveOperationMilliseconds,
        maximumItems: 1,
        maximumPages: null,
        maximumPixelsPerEdge: null,
        maximumSlides: null,
      },
      toolRequirements: ["readFile", "validateFileFields"],
    }),
    entry("file-analysis", "Analyze one bounded owned file.", "file.analyze", {
      availabilityRequirements: ["file-storage"],
      resultBounds: {
        maximumBytes: policyCatalog.operationLimits.verifiedComputeOutputBytes,
        maximumDurationMillis: policyCatalog.operationLimits.computeMilliseconds,
        maximumItems: 1,
        maximumPages: null,
        maximumPixelsPerEdge: null,
        maximumSlides: null,
      },
      toolRequirements: ["analyzeFile"],
    }),
    entry("document-generation", "Generate one bounded PDF or DOCX.", "artifact.generate", {
      availabilityRequirements: ["document-renderer", "file-storage"],
      resultBounds: {
        maximumBytes: policyCatalog.operationLimits.generatedDocumentBytes,
        maximumDurationMillis: policyCatalog.operationLimits.durableArtifactOperationMilliseconds,
        maximumItems: 1,
        maximumPages: policyCatalog.operationLimits.generatedDocumentPages,
        maximumPixelsPerEdge: null,
        maximumSlides: null,
      },
      skillCandidates: ["document-production"],
      toolRequirements: ["generateDocument", "inspectPdfForm"],
    }),
    entry(
      "document-build",
      "Build one bounded PDF or DOCX from owned ready files.",
      "workflow.manage",
      {
        availabilityRequirements: ["document-renderer", "file-storage", "workflow-store"],
        resultBounds: {
          maximumBytes: policyCatalog.operationLimits.generatedDocumentBytes,
          maximumDurationMillis: policyCatalog.operationLimits.durableArtifactOperationMilliseconds,
          maximumItems: 1,
          maximumPages: policyCatalog.operationLimits.generatedDocumentPages,
          maximumPixelsPerEdge: null,
          maximumSlides: null,
        },
        skillCandidates: ["document-build"],
        toolRequirements: ["cancelDocumentBuild", "inspectDocumentBuild", "startDocumentBuild"],
      },
    ),
    entry("document-read", "Read or export an owned PDF or DOCX.", "artifact.read", {
      availabilityRequirements: ["file-storage"],
      resultBounds: {
        maximumBytes: policyCatalog.operationLimits.generatedDocumentBytes,
        maximumDurationMillis: policyCatalog.operationLimits.interactiveOperationMilliseconds,
        maximumItems: 1,
        maximumPages: policyCatalog.operationLimits.generatedDocumentPages,
        maximumPixelsPerEdge: null,
        maximumSlides: null,
      },
      toolRequirements: ["exportDocument"],
    }),
    entry(
      "document-delete",
      "Delete an owned generated document after Approval.",
      "artifact.delete",
      {
        availabilityRequirements: ["file-storage"],
        toolRequirements: ["deleteDocument"],
      },
    ),
    entry("artifact-read", "Read or export one owned visual artifact.", "artifact.read", {
      availabilityRequirements: ["file-storage"],
      resultBounds: {
        maximumBytes: policyCatalog.operationLimits.generatedPresentationBytes,
        maximumDurationMillis: policyCatalog.operationLimits.interactiveOperationMilliseconds,
        maximumItems: 1,
        maximumPages: null,
        maximumPixelsPerEdge: policyCatalog.operationLimits.generatedImagePixelsPerEdge,
        maximumSlides: policyCatalog.operationLimits.generatedPresentationSlides,
      },
      toolRequirements: ["exportArtifact"],
    }),
    entry(
      "artifact-delete",
      "Delete one owned visual artifact after Approval.",
      "artifact.delete",
      {
        availabilityRequirements: ["file-storage"],
        toolRequirements: ["deleteArtifact"],
      },
    ),
    entry("web-search", "Search the public web within bounded results.", "web.search", {
      availabilityRequirements: ["web-provider"],
      resultBounds: {
        maximumBytes: null,
        maximumDurationMillis: policyCatalog.operationLimits.interactiveOperationMilliseconds,
        maximumItems: policyCatalog.operationLimits.webResultsPerSearch,
        maximumPages: null,
        maximumPixelsPerEdge: null,
        maximumSlides: null,
      },
      skillCandidates: ["web-search"],
      toolRequirements: ["webSearch"],
    }),
    entry("page-read", "Read one bounded public web page.", "web.read", {
      availabilityRequirements: ["personal-agent"],
      resultBounds: {
        maximumBytes: policyCatalog.operationLimits.webNormalizedPageBytes,
        maximumDurationMillis: policyCatalog.operationLimits.interactiveOperationMilliseconds,
        maximumItems: 1,
        maximumPages: null,
        maximumPixelsPerEdge: null,
        maximumSlides: null,
      },
      toolRequirements: ["readWebPage"],
    }),
    entry("research-report", "Produce one bounded research report.", "artifact.generate", {
      availabilityRequirements: [
        "document-renderer",
        "file-storage",
        "web-provider",
        "workflow-store",
      ],
      resultBounds: {
        maximumBytes: policyCatalog.operationLimits.generatedDocumentBytes,
        maximumDurationMillis: policyCatalog.operationLimits.researchOperationMilliseconds,
        maximumItems: policyCatalog.operationLimits.researchArtifactCount,
        maximumPages: policyCatalog.operationLimits.generatedDocumentPages,
        maximumPixelsPerEdge: null,
        maximumSlides: null,
      },
      toolRequirements: ["startResearchReport"],
    }),
    entry("presentation-generation", "Generate one bounded presentation.", "artifact.generate", {
      availabilityRequirements: ["document-renderer", "file-storage"],
      resultBounds: {
        maximumBytes: policyCatalog.operationLimits.generatedPresentationBytes,
        maximumDurationMillis: policyCatalog.operationLimits.durableArtifactOperationMilliseconds,
        maximumItems: 1,
        maximumPages: null,
        maximumPixelsPerEdge: null,
        maximumSlides: policyCatalog.operationLimits.generatedPresentationSlides,
      },
      skillCandidates: ["presentation-production"],
      toolRequirements: ["generatePresentation", "revisePresentation"],
    }),
    entry("image-generation", "Generate one bounded image.", "artifact.generate", {
      availabilityRequirements: ["document-renderer", "file-storage"],
      resultBounds: generatedImageResultBounds,
      toolRequirements: ["generateImage"],
    }),
    entry("diagram-generation", "Generate one bounded diagram.", "artifact.generate", {
      availabilityRequirements: ["document-renderer", "file-storage"],
      resultBounds: generatedImageResultBounds,
      toolRequirements: ["generateDiagram"],
    }),
    entry("skill-management", "Inspect or manage personal Skills.", "skill.manage", {
      availabilityRequirements: ["skill-store"],
      toolRequirements: ["osfoDeletePersonalSkill", "skillInspect", "skillManage"],
    }),
    entry("reminders", "Manage bounded reminders.", "reminder.manage", {
      availabilityRequirements: ["reminder-store"],
      toolRequirements: ["osfoCancelReminder", "osfoInspectReminder", "osfoManageReminder"],
    }),
    entry("workflows", "Inspect or cancel supported durable Workflows.", "workflow.inspect", {
      availabilityRequirements: ["workflow-store"],
      toolRequirements: ["cancelResearchReport", "inspectResearchReport"],
    }),
    integrationEntry("gmail", "Use approved Gmail operations.", "gmail"),
    integrationEntry(
      "google-calendar",
      "Use approved Google Calendar operations.",
      "google-calendar",
    ),
    integrationEntry("google-drive", "Use approved Google Drive operations.", "google-drive"),
    entry("usage-management", "Inspect Plan Usage and billing state.", "usage.inspect"),
  ] as const satisfies ReadonlyArray<CatalogEntry>;
};

const catalogEntry = (policyCatalog: CapabilityCatalog) =>
  function entry<const Id extends CapabilityId>(
    id: Id,
    description: string,
    planPolicyOperation: GovernedAuthorizationOperationName,
    options: Partial<
      Pick<
        CatalogEntry,
        | "availabilityRequirements"
        | "integrationToolkit"
        | "resultBounds"
        | "skillCandidates"
        | "toolRequirements"
      >
    > = {},
  ) {
    return {
      availabilityRequirements: [
        "personal-agent" as const,
        ...(options.availabilityRequirements ?? []),
      ],
      description,
      id,
      integrationToolkit: options.integrationToolkit ?? null,
      planPolicyOperation,
      resultBounds: options.resultBounds ?? {
        maximumBytes: null,
        maximumDurationMillis: policyCatalog.operationLimits.interactiveOperationMilliseconds,
        maximumItems: 1,
        maximumPages: null,
        maximumPixelsPerEdge: null,
        maximumSlides: null,
      },
      skillCandidates: options.skillCandidates ?? [],
      taskKinds: capabilityIntentPolicy[id].taskKinds,
      toolRequirements: options.toolRequirements ?? [],
    } as const;
  };

const catalogIntegrationEntry = (policyCatalog: CapabilityCatalog) => {
  const entry = catalogEntry(policyCatalog);
  return function integrationEntry<const Id extends "gmail" | "google-calendar" | "google-drive">(
    id: Id,
    description: string,
    toolkit: Id,
  ) {
    return entry(id, description, "integration.read", {
      availabilityRequirements: ["composio"],
      integrationToolkit: toolkit,
      toolRequirements:
        id === "gmail"
          ? [
              "cancelScheduledEmail",
              "gmailFetchThread",
              "gmailSearchEmails",
              "gmailSendEmail",
              "inspectScheduledEmail",
              "scheduleEmail",
            ]
          : id === "google-calendar"
            ? [
                "calendarCreateEvent",
                "calendarDeleteEvent",
                "calendarFindAvailability",
                "calendarListEvents",
                "calendarUpdateEvent",
              ]
            : ["driveDeliverArtifact", "driveGetMetadata", "driveReadFile", "driveSearch"],
      resultBounds: {
        maximumBytes: policyCatalog.integrationReadLimits.totalResponseBytes,
        maximumDurationMillis: policyCatalog.operationLimits.interactiveOperationMilliseconds,
        maximumItems: policyCatalog.integrationReadLimits.recordsPerCall,
        maximumPages: null,
        maximumPixelsPerEdge: null,
        maximumSlides: null,
      },
    });
  };
};
