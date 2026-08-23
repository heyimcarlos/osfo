import { Result, Schema } from "effect";

import { ManifestVersion } from "../domain";
import { ConsequenceClass } from "./capability-catalog";

const nonEmpty = Schema.String.check(Schema.isMinLength(1));
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
  consequences: Schema.Array(ConsequenceClass),
  exhaustedMode: Schema.NullOr(ExhaustedManifestRead),
  idempotency: Schema.Literals(["readOnly", "actionIdentity"]),
  manifestVersion: ManifestVersion,
  operation: nonEmpty,
  operationKind: Schema.Literals(["read", "effect"]),
  requiredConnection: Schema.Literal(true),
  toolkit: nonEmpty,
});

export type IntegrationManifestOperation = typeof IntegrationManifestOperation.Type;

export const IntegrationManifestCatalog = Schema.Struct({
  manifests: Schema.Array(IntegrationManifestOperation),
});

export class IntegrationManifestUnavailable extends Schema.TaggedError<IntegrationManifestUnavailable>()(
  "IntegrationManifestUnavailable",
  {
    manifestVersion: Schema.String,
    operation: Schema.String,
    toolkit: Schema.String,
  },
) {}

const manifestInput = {
  manifests: [
    {
      completedEvidence: "zeroMarginalCost",
      consequences: [],
      exhaustedMode: { _tag: "EmailThread", maximumMessages: 20, responseBytes: 65_536 },
      idempotency: "readOnly",
      manifestVersion: "gmail-v1",
      operation: "GMAIL_FETCH_THREAD",
      operationKind: "read",
      requiredConnection: true,
      toolkit: "gmail",
    },
    {
      completedEvidence: "zeroMarginalCost",
      consequences: [],
      exhaustedMode: null,
      idempotency: "actionIdentity",
      manifestVersion: "gmail-v1",
      operation: "GMAIL_CREATE_DRAFT",
      operationKind: "effect",
      requiredConnection: true,
      toolkit: "gmail",
    },
    {
      completedEvidence: "zeroMarginalCost",
      consequences: ["externalCommunication"],
      exhaustedMode: null,
      idempotency: "actionIdentity",
      manifestVersion: "gmail-v1",
      operation: "GMAIL_SEND_EMAIL",
      operationKind: "effect",
      requiredConnection: true,
      toolkit: "gmail",
    },
    {
      completedEvidence: "zeroMarginalCost",
      consequences: [],
      exhaustedMode: { _tag: "CalendarEvents", maximumEvents: 10, windowDays: 14 },
      idempotency: "readOnly",
      manifestVersion: "calendar-v1",
      operation: "CALENDAR_LIST_EVENTS",
      operationKind: "read",
      requiredConnection: true,
      toolkit: "googlecalendar",
    },
    {
      completedEvidence: "zeroMarginalCost",
      consequences: [],
      exhaustedMode: null,
      idempotency: "actionIdentity",
      manifestVersion: "calendar-v1",
      operation: "CALENDAR_CREATE_PRIVATE",
      operationKind: "effect",
      requiredConnection: true,
      toolkit: "googlecalendar",
    },
    {
      completedEvidence: "zeroMarginalCost",
      consequences: ["destructionOrOverwrite"],
      exhaustedMode: null,
      idempotency: "actionIdentity",
      manifestVersion: "calendar-v1",
      operation: "CALENDAR_UPDATE_EVENT",
      operationKind: "effect",
      requiredConnection: true,
      toolkit: "googlecalendar",
    },
    {
      completedEvidence: "zeroMarginalCost",
      consequences: [],
      exhaustedMode: { _tag: "ProviderMetadata", items: 1, responseBytes: 16_384 },
      idempotency: "readOnly",
      manifestVersion: "drive-v1",
      operation: "DRIVE_GET_METADATA",
      operationKind: "read",
      requiredConnection: true,
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

export const resolveManifest = (toolkit: string, operation: string, manifestVersion: string) => {
  const manifest = currentManifestCatalog.manifests.find(
    (candidate) =>
      candidate.toolkit === toolkit &&
      candidate.operation === operation &&
      candidate.manifestVersion === manifestVersion,
  );
  return manifest === undefined
    ? Result.fail(new IntegrationManifestUnavailable({ manifestVersion, operation, toolkit }))
    : Result.succeed(manifest);
};
