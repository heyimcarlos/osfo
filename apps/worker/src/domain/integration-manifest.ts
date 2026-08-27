import { Result, Schema } from "effect";

import { ManifestVersion } from "../domain";
import { ConsequenceClass } from "./capability-catalog";

const nonEmpty = Schema.String.check(Schema.isMinLength(1));
const boundedIdentity = nonEmpty.check(Schema.isMaxLength(500));
const boundedSummary = nonEmpty.check(Schema.isMaxLength(64_000));
const positiveIntegerAtMost = (maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }));
const nonNegativeIntegerAtMost = (maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum }));
const nonNegativeBytesAtMost = (maximum: bigint) =>
  Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: 0n, maximum }));

export const IntegrationManifestSafeError = Schema.Literals([
  "connectionUnavailable",
  "inputRejected",
  "notFound",
  "permissionDenied",
  "providerRateLimited",
  "providerUnavailable",
  "resultInvalid",
]);

export const IntegrationManifestHardBounds = Schema.Struct({
  maximumRecords: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  maximumResponseBytes: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  mutations: Schema.Literals([0, 1]),
  providerExecutions: Schema.Literal(1),
});
/** Manifest-declared read that remains available under the shared exhausted envelope. */
export const ExhaustedManifestRead = Schema.Union([
  Schema.TaggedStruct("EmailThread", {
    maximumMessages: Schema.Literal(20),
    responseBytes: Schema.Literal(65_536),
  }),
  Schema.TaggedStruct("CalendarEvents", {
    maximumEvents: Schema.Literal(10),
    windowDays: Schema.Literal(14),
  }),
  Schema.TaggedStruct("Availability", {
    calendars: Schema.Literal(1),
    windowDays: Schema.Literal(14),
  }),
  Schema.TaggedStruct("ProviderMetadata", {
    items: Schema.Literal(1),
    responseBytes: Schema.Literal(16_384),
  }),
]);

/** One allowlisted provider operation and its complete authorization contract. */
export const IntegrationManifestOperation = Schema.Struct({
  completedEvidence: Schema.Literals(["zeroMarginalCost", "normalizedNonModelCost"]),
  completedEvidenceContract: Schema.Literals(["boundedReadV1", "singleMutationV1"]),
  consequences: Schema.Array(ConsequenceClass),
  exhaustedMode: Schema.NullOr(ExhaustedManifestRead),
  hardBounds: IntegrationManifestHardBounds,
  idempotency: Schema.Literals(["readOnly", "actionIdentity"]),
  inputContract: Schema.Literals([
    "gmailFetchThreadV1",
    "gmailMessageV1",
    "calendarListEventsV1",
    "calendarCreatePrivateV1",
    "calendarUpdateEventV1",
    "driveGetMetadataV1",
  ]),
  manifestVersion: ManifestVersion,
  operation: nonEmpty,
  operationKind: Schema.Literals(["read", "effect"]),
  outputContract: Schema.Literals([
    "gmailThreadV1",
    "gmailMutationV1",
    "calendarEventsV1",
    "calendarMutationV1",
    "driveMetadataV1",
  ]),
  providerTool: nonEmpty,
  requiredConnection: Schema.Literal(true),
  safeErrors: Schema.NonEmptyArray(IntegrationManifestSafeError),
  toolkit: nonEmpty,
}).check(
  Schema.makeFilter(
    (manifest) =>
      (manifest.operationKind === "read" &&
        manifest.completedEvidenceContract === "boundedReadV1" &&
        manifest.hardBounds.mutations === 0) ||
      (manifest.operationKind === "effect" &&
        manifest.completedEvidenceContract === "singleMutationV1" &&
        manifest.hardBounds.mutations === 1) ||
      "operation kind, completed evidence, and mutation bound must agree",
  ),
);

export type IntegrationManifestOperation = typeof IntegrationManifestOperation.Type;

export class IntegrationManifestValueInvalid extends Schema.TaggedError<IntegrationManifestValueInvalid>()(
  "IntegrationManifestValueInvalid",
  {
    boundary: Schema.Literals(["completedEvidence", "providerInput"]),
    cause: Schema.Defect(),
    manifestVersion: ManifestVersion,
    message: Schema.String,
    operation: Schema.String,
    toolkit: Schema.String,
  },
) {}

/* oxlint-disable osfo/no-unknown-parameters -- Resolved manifests own provider input and evidence trust boundaries. */
export interface ResolvedIntegrationManifestOperation extends IntegrationManifestOperation {
  readonly decodeCompletedEvidence: (
    input: unknown,
  ) => Result.Result<unknown, IntegrationManifestValueInvalid>;
  readonly decodeInput: (
    input: unknown,
  ) => Result.Result<Schema.Json, IntegrationManifestValueInvalid>;
}
/* oxlint-enable osfo/no-unknown-parameters */

export const IntegrationManifestCatalog = Schema.Struct({
  manifests: Schema.Array(IntegrationManifestOperation),
}).check(
  Schema.makeFilter(
    (catalog) =>
      new Set(
        catalog.manifests.map(
          ({ manifestVersion, operation, toolkit }) =>
            `${manifestVersion}\u0000${toolkit}\u0000${operation}`,
        ),
      ).size === catalog.manifests.length ||
      "manifest operation identities must be unique within one catalog",
  ),
);

export type IntegrationManifestCatalog = typeof IntegrationManifestCatalog.Type;

export class IntegrationManifestUnavailable extends Schema.TaggedError<IntegrationManifestUnavailable>()(
  "IntegrationManifestUnavailable",
  {
    manifestVersion: ManifestVersion,
    operation: Schema.String,
    toolkit: Schema.String,
  },
) {}

export const GmailFetchThreadInput = Schema.Struct({
  includeAttachments: Schema.Literal(false),
  maximumMessages: positiveIntegerAtMost(20),
  threadId: boundedIdentity,
});

export const GmailMessageInput = Schema.Struct({
  body: boundedSummary,
  recipients: Schema.NonEmptyArray(boundedIdentity).check(Schema.isMaxLength(50)),
  subject: nonEmpty.check(Schema.isMaxLength(998)),
});

export const CalendarListEventsInput = Schema.Struct({
  calendarId: boundedIdentity,
  endsAt: boundedIdentity,
  maximumEvents: positiveIntegerAtMost(10),
  startsAt: boundedIdentity,
});

export const CalendarCreatePrivateInput = Schema.Struct({
  attendeeCount: Schema.Literal(0),
  calendarId: boundedIdentity,
  endsAt: boundedIdentity,
  sendNotifications: Schema.Literal(false),
  startsAt: boundedIdentity,
  title: nonEmpty.check(Schema.isMaxLength(500)),
});

export const CalendarUpdateEventInput = Schema.Struct({
  calendarId: boundedIdentity,
  changes: Schema.Struct({
    description: Schema.optional(boundedSummary),
    endsAt: Schema.optional(boundedIdentity),
    location: Schema.optional(boundedIdentity),
    startsAt: Schema.optional(boundedIdentity),
    title: Schema.optional(nonEmpty.check(Schema.isMaxLength(500))),
  }).check(
    Schema.makeFilter(
      (changes) =>
        Object.values(changes).some((value) => value !== undefined) ||
        "at least one exact Calendar field must change",
    ),
  ),
  eventId: boundedIdentity,
  sendNotifications: Schema.Literal(false),
});

export const DriveGetMetadataInput = Schema.Struct({ fileId: boundedIdentity });

const readCompletedEvidence = (maximumRecords: number, maximumResponseBytes: bigint) =>
  Schema.TaggedStruct("CompletedIntegrationRead", {
    providerExecutionId: boundedIdentity,
    records: nonNegativeIntegerAtMost(maximumRecords),
    responseBytes: nonNegativeBytesAtMost(maximumResponseBytes),
  });

const CompletedIntegrationEffect = Schema.TaggedStruct("CompletedIntegrationEffect", {
  mutations: Schema.Literal(1),
  providerExecutionId: boundedIdentity,
});

const readSafeErrors = [
  "connectionUnavailable",
  "inputRejected",
  "notFound",
  "providerRateLimited",
  "providerUnavailable",
  "resultInvalid",
] as const;

const effectSafeErrors = [
  "connectionUnavailable",
  "inputRejected",
  "notFound",
  "permissionDenied",
  "providerRateLimited",
  "providerUnavailable",
  "resultInvalid",
] as const;

const manifestInput = {
  manifests: [
    {
      completedEvidence: "zeroMarginalCost",
      completedEvidenceContract: "boundedReadV1",
      consequences: [],
      exhaustedMode: { _tag: "EmailThread", maximumMessages: 20, responseBytes: 65_536 },
      hardBounds: {
        maximumRecords: 20,
        maximumResponseBytes: 65_536n,
        mutations: 0,
        providerExecutions: 1,
      },
      idempotency: "readOnly",
      inputContract: "gmailFetchThreadV1",
      manifestVersion: "gmail-v1",
      operation: "GMAIL_FETCH_THREAD",
      operationKind: "read",
      outputContract: "gmailThreadV1",
      providerTool: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      requiredConnection: true,
      safeErrors: readSafeErrors,
      toolkit: "gmail",
    },
    {
      completedEvidence: "zeroMarginalCost",
      completedEvidenceContract: "singleMutationV1",
      consequences: [],
      exhaustedMode: null,
      hardBounds: {
        maximumRecords: 0,
        maximumResponseBytes: 65_536n,
        mutations: 1,
        providerExecutions: 1,
      },
      idempotency: "actionIdentity",
      inputContract: "gmailMessageV1",
      manifestVersion: "gmail-v1",
      operation: "GMAIL_CREATE_DRAFT",
      operationKind: "effect",
      outputContract: "gmailMutationV1",
      providerTool: "GMAIL_CREATE_EMAIL_DRAFT",
      requiredConnection: true,
      safeErrors: effectSafeErrors,
      toolkit: "gmail",
    },
    {
      completedEvidence: "zeroMarginalCost",
      completedEvidenceContract: "singleMutationV1",
      consequences: ["externalCommunication"],
      exhaustedMode: null,
      hardBounds: {
        maximumRecords: 0,
        maximumResponseBytes: 65_536n,
        mutations: 1,
        providerExecutions: 1,
      },
      idempotency: "actionIdentity",
      inputContract: "gmailMessageV1",
      manifestVersion: "gmail-v1",
      operation: "GMAIL_SEND_EMAIL",
      operationKind: "effect",
      outputContract: "gmailMutationV1",
      providerTool: "GMAIL_SEND_EMAIL",
      requiredConnection: true,
      safeErrors: effectSafeErrors,
      toolkit: "gmail",
    },
    {
      completedEvidence: "zeroMarginalCost",
      completedEvidenceContract: "boundedReadV1",
      consequences: [],
      exhaustedMode: { _tag: "CalendarEvents", maximumEvents: 10, windowDays: 14 },
      hardBounds: {
        maximumRecords: 10,
        maximumResponseBytes: 65_536n,
        mutations: 0,
        providerExecutions: 1,
      },
      idempotency: "readOnly",
      inputContract: "calendarListEventsV1",
      manifestVersion: "calendar-v1",
      operation: "CALENDAR_LIST_EVENTS",
      operationKind: "read",
      outputContract: "calendarEventsV1",
      providerTool: "GOOGLECALENDAR_EVENTS_LIST",
      requiredConnection: true,
      safeErrors: readSafeErrors,
      toolkit: "googlecalendar",
    },
    {
      completedEvidence: "zeroMarginalCost",
      completedEvidenceContract: "singleMutationV1",
      consequences: [],
      exhaustedMode: null,
      hardBounds: {
        maximumRecords: 0,
        maximumResponseBytes: 65_536n,
        mutations: 1,
        providerExecutions: 1,
      },
      idempotency: "actionIdentity",
      inputContract: "calendarCreatePrivateV1",
      manifestVersion: "calendar-v1",
      operation: "CALENDAR_CREATE_PRIVATE",
      operationKind: "effect",
      outputContract: "calendarMutationV1",
      providerTool: "GOOGLECALENDAR_CREATE_EVENT",
      requiredConnection: true,
      safeErrors: effectSafeErrors,
      toolkit: "googlecalendar",
    },
    {
      completedEvidence: "zeroMarginalCost",
      completedEvidenceContract: "singleMutationV1",
      consequences: ["destructionOrOverwrite"],
      exhaustedMode: null,
      hardBounds: {
        maximumRecords: 0,
        maximumResponseBytes: 65_536n,
        mutations: 1,
        providerExecutions: 1,
      },
      idempotency: "actionIdentity",
      inputContract: "calendarUpdateEventV1",
      manifestVersion: "calendar-v1",
      operation: "CALENDAR_UPDATE_EVENT",
      operationKind: "effect",
      outputContract: "calendarMutationV1",
      providerTool: "GOOGLECALENDAR_PATCH_EVENT",
      requiredConnection: true,
      safeErrors: effectSafeErrors,
      toolkit: "googlecalendar",
    },
    {
      completedEvidence: "zeroMarginalCost",
      completedEvidenceContract: "boundedReadV1",
      consequences: [],
      exhaustedMode: { _tag: "ProviderMetadata", items: 1, responseBytes: 16_384 },
      hardBounds: {
        maximumRecords: 1,
        maximumResponseBytes: 16_384n,
        mutations: 0,
        providerExecutions: 1,
      },
      idempotency: "readOnly",
      inputContract: "driveGetMetadataV1",
      manifestVersion: "drive-v1",
      operation: "DRIVE_GET_METADATA",
      operationKind: "read",
      outputContract: "driveMetadataV1",
      providerTool: "GOOGLEDRIVE_GET_FILE_METADATA",
      requiredConnection: true,
      safeErrors: readSafeErrors,
      toolkit: "googledrive",
    },
  ],
};

export const currentManifestCatalog = Schema.decodeUnknownSync(IntegrationManifestCatalog)(
  manifestInput,
);

// oxlint-disable-next-line osfo/no-unknown-parameters -- This function is the schema parser at the manifest boundary.
export const parseManifestCatalog = (input: unknown) =>
  Schema.decodeUnknownResult(IntegrationManifestCatalog)(input, { onExcessProperty: "error" });

export const resolveManifest = (
  identity: {
    readonly manifestVersion: ManifestVersion;
    readonly operation: string;
    readonly toolkit: string;
  },
  catalog: IntegrationManifestCatalog = currentManifestCatalog,
) => {
  const manifest = catalog.manifests.find(
    (candidate) =>
      candidate.toolkit === identity.toolkit &&
      candidate.operation === identity.operation &&
      candidate.manifestVersion === identity.manifestVersion,
  );
  return manifest === undefined
    ? Result.fail(new IntegrationManifestUnavailable(identity))
    : Result.succeed({
        ...manifest,
        decodeCompletedEvidence: completedEvidenceDecoderFor(manifest),
        decodeInput: inputDecoderFor(manifest),
      } satisfies ResolvedIntegrationManifestOperation);
};

const inputDecoderFor = (
  manifest: IntegrationManifestOperation,
): ResolvedIntegrationManifestOperation["decodeInput"] => {
  switch (manifest.inputContract) {
    case "gmailFetchThreadV1":
      return inputManifestDecoder(GmailFetchThreadInput, manifest);
    case "gmailMessageV1":
      return inputManifestDecoder(GmailMessageInput, manifest);
    case "calendarListEventsV1":
      return inputManifestDecoder(CalendarListEventsInput, manifest);
    case "calendarCreatePrivateV1":
      return inputManifestDecoder(CalendarCreatePrivateInput, manifest);
    case "calendarUpdateEventV1":
      return inputManifestDecoder(CalendarUpdateEventInput, manifest);
    case "driveGetMetadataV1":
      return inputManifestDecoder(DriveGetMetadataInput, manifest);
    default:
      return manifest.inputContract satisfies never;
  }
};

const completedEvidenceDecoderFor = (
  manifest: IntegrationManifestOperation,
): ResolvedIntegrationManifestOperation["decodeCompletedEvidence"] => {
  switch (manifest.completedEvidenceContract) {
    case "boundedReadV1":
      return manifestDecoder(
        readCompletedEvidence(
          manifest.hardBounds.maximumRecords,
          manifest.hardBounds.maximumResponseBytes,
        ),
        manifest,
        "completedEvidence",
      );
    case "singleMutationV1":
      return manifestDecoder(CompletedIntegrationEffect, manifest, "completedEvidence");
    default:
      return manifest.completedEvidenceContract satisfies never;
  }
};

const manifestDecoder =
  <S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    manifest: IntegrationManifestOperation,
    boundary: IntegrationManifestValueInvalid["boundary"],
  ) =>
  // oxlint-disable-next-line osfo/no-unknown-parameters -- Manifest decoders own provider trust boundaries.
  (input: unknown): Result.Result<S["Type"], IntegrationManifestValueInvalid> =>
    Result.mapError(
      Schema.decodeUnknownResult(schema)(input, { onExcessProperty: "error" }),
      (cause) =>
        new IntegrationManifestValueInvalid({
          boundary,
          cause,
          manifestVersion: manifest.manifestVersion,
          message:
            boundary === "providerInput"
              ? "The provider operation input violates its manifest"
              : "The completed provider evidence violates its manifest",
          operation: manifest.operation,
          toolkit: manifest.toolkit,
        }),
    );

const inputManifestDecoder =
  (schema: Schema.ConstraintDecoder<unknown>, manifest: IntegrationManifestOperation) =>
  // oxlint-disable-next-line osfo/no-unknown-parameters -- Manifest input schemas own this trust boundary.
  (input: unknown): Result.Result<Schema.Json, IntegrationManifestValueInvalid> =>
    Result.map(manifestDecoder(schema, manifest, "providerInput")(input), (decoded) =>
      Schema.decodeUnknownSync(Schema.Json)(decoded),
    );
