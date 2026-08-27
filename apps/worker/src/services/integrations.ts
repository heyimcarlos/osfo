import { Effect, Option, Predicate, Result, Schema, Semaphore } from "effect";

import type { ActionId } from "../domain/action-execution";
import { ManifestVersion, type UserId } from "../domain";
import {
  CalendarAvailabilityInput,
  CalendarCreateEventInput,
  CalendarDeleteEventInput,
  CalendarListEventsInput,
  CalendarUpdateEventInput,
  DriveDeliverArtifactInput,
  DriveGetMetadataInput,
  DriveReadFileInput,
  DriveSearchInput,
  GmailFetchThreadInput,
  GmailMessageInput,
  GmailSearchInput,
  IntegrationManifestUnavailable,
  resolveManifest,
  type IntegrationManifestValueInvalid,
  type ResolvedIntegrationManifestOperation,
} from "../domain/integration-manifest";

/* oxlint-disable eslint/no-underscore-dangle -- Integration outcomes use the repository's _tag discriminator. */

const providerTools = [
  "GMAIL_FETCH_EMAILS",
  "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
  "GMAIL_SEND_EMAIL",
  "GOOGLECALENDAR_EVENTS_LIST",
  "GOOGLECALENDAR_FIND_FREE_SLOTS",
  "GOOGLECALENDAR_CREATE_EVENT",
  "GOOGLECALENDAR_PATCH_EVENT",
  "GOOGLECALENDAR_DELETE_EVENT",
  "GOOGLEDRIVE_FIND_FILE",
  "GOOGLEDRIVE_GET_FILE_METADATA",
  "GOOGLEDRIVE_DOWNLOAD_FILE",
  "GOOGLEDRIVE_UPLOAD_FILE",
] as const;

/** Exact provider session confinement applied to every Osfo User mapping. */
export const directIntegrationProviderConfig = {
  manageConnections: false,
  multiAccount: false,
  preset: "direct-tools" as const,
  sandbox: false,
  toolkits: ["gmail", "googlecalendar", "googledrive"] as const,
  tools: providerTools,
};

export interface ProviderToolkitEvidence {
  readonly connectedAccount: { readonly id: string; readonly status: string } | null;
  readonly isActive: boolean;
  readonly slug: string;
}

export interface ProviderExecutionResult {
  readonly data: Schema.JsonObject;
  readonly error: string | null;
  readonly logId: string;
}

export type ProviderInput =
  | {
      readonly ids_only: false;
      readonly include_payload: false;
      readonly include_spam_trash: false;
      readonly max_results: number;
      readonly query: string;
      readonly user_id: "me";
      readonly verbose: false;
    }
  | {
      readonly body: string;
      readonly extra_recipients?: ReadonlyArray<string>;
      readonly is_html: false;
      readonly recipient_email: string;
      readonly subject: string;
      readonly user_id: "me";
    }
  | {
      readonly thread_id: string;
      readonly user_id: "me";
    }
  | {
      readonly calendarId: string;
      readonly maxResults: number;
      readonly showDeleted: false;
      readonly singleEvents: true;
      readonly timeMax: string;
      readonly timeMin: string;
      readonly timeZone: string;
    }
  | {
      readonly calendar_expansion_max: 1;
      readonly group_expansion_max: 1;
      readonly items: readonly [string];
      readonly time_max: string;
      readonly time_min: string;
      readonly timezone: string;
    }
  | {
      readonly attendees: readonly [];
      readonly calendar_id: string;
      readonly create_meeting_room: false;
      readonly end_datetime: string;
      readonly exclude_organizer: true;
      readonly recurrence?: ReadonlyArray<string>;
      readonly send_updates: "none";
      readonly start_datetime: string;
      readonly summary: string;
      readonly timezone: string;
      readonly visibility: "private";
    }
  | ({
      readonly calendar_id: string;
      readonly event_id: string;
      readonly send_updates: "none";
    } & CalendarPatchInput)
  | {
      readonly calendar_id: string;
      readonly event_id: string;
      readonly send_updates: "none";
    }
  | {
      readonly corpora: "user";
      readonly fields: "files(id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,trashed)";
      readonly includeItemsFromAllDrives: false;
      readonly pageSize: number;
      readonly q: string;
      readonly spaces: "drive";
      readonly supportsAllDrives: false;
    }
  | {
      readonly fields: "id,name,mimeType,size,modifiedTime,webViewLink";
      readonly fileId: string;
      readonly supportsAllDrives: true;
    }
  | {
      readonly file_id: string;
      readonly mime_type: string;
    }
  | {
      readonly file_to_upload: {
        readonly mimetype: string;
        readonly name: string;
        readonly s3key: string;
      };
      readonly folder_to_upload_to: string | null;
    };

export interface IntegrationArtifact {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mediaType: string;
}

export interface IntegrationArtifactAccess {
  readonly readOwned: (input: {
    readonly artifactId: string;
    readonly expectedBytes: number;
    readonly fileName: string;
    readonly mediaType: string;
    readonly userId: UserId;
  }) => Effect.Effect<IntegrationArtifact, IntegrationArtifactUnavailable>;
}

/** Narrow Composio boundary. Meta tools, arbitrary discovery, and sandbox APIs are absent. */
export interface ProviderSession {
  readonly authorize: (
    toolkit: string,
    callbackUrl: URL,
  ) => Effect.Effect<URL, IntegrationProviderUnavailable>;
  readonly execute: (
    providerTool: string,
    input: ProviderInput,
    connectedAccountId: string,
  ) => Effect.Effect<ProviderExecutionResult, IntegrationProviderUnavailable>;
  readonly disconnect: (
    connectedAccountId: string,
  ) => Effect.Effect<void, IntegrationProviderUnavailable>;
  readonly inspectToolkits: (
    toolkits: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<ProviderToolkitEvidence>, IntegrationProviderUnavailable>;
  readonly stageFile: (
    artifact: IntegrationArtifact,
  ) => Effect.Effect<
    { readonly mimetype: string; readonly name: string; readonly s3key: string },
    IntegrationProviderUnavailable
  >;
}

/** Provider operations required by the deep Integrations module. */
export interface IntegrationProvider {
  readonly createSession: (
    userId: UserId,
    config: typeof directIntegrationProviderConfig,
  ) => Effect.Effect<
    { readonly providerSessionId: string; readonly session: ProviderSession },
    IntegrationProviderUnavailable
  >;
  readonly useSession: (
    userId: UserId,
    providerSessionId: string,
  ) => Effect.Effect<ProviderSession, IntegrationProviderUnavailable>;
}

export type PersistedIntegrationAction =
  | { readonly _tag: "Pending"; readonly digest: string }
  | { readonly _tag: "Ambiguous"; readonly digest: string }
  | { readonly _tag: "NotApplied"; readonly digest: string }
  | {
      readonly _tag: "Applied";
      readonly digest: string;
      readonly result: IntegrationEffectCompleted;
    };

/** Osfo-owned durable state. Provider session identities never cross this persistence seam. */
export interface IntegrationPersistence {
  readonly readAction: (
    actionId: ActionId,
  ) => Effect.Effect<PersistedIntegrationAction | null, IntegrationPersistenceUnavailable>;
  readonly readSession: (
    userId: UserId,
  ) => Effect.Effect<string | null, IntegrationPersistenceUnavailable>;
  readonly retainAction: (
    actionId: ActionId,
    value: PersistedIntegrationAction,
  ) => Effect.Effect<void, IntegrationPersistenceUnavailable>;
  readonly retainSession: (
    userId: UserId,
    providerSessionId: string,
  ) => Effect.Effect<string, IntegrationPersistenceUnavailable>;
  readonly replaceSession: (
    userId: UserId,
    expectedProviderSessionId: string,
    replacementProviderSessionId: string,
  ) => Effect.Effect<string, IntegrationPersistenceUnavailable>;
}

export class IntegrationProviderUnavailable extends Schema.TaggedError<IntegrationProviderUnavailable>()(
  "IntegrationProviderUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.String,
    reason: Schema.Literals(["missing", "unavailable"]),
  },
) {}

export class IntegrationPersistenceUnavailable extends Schema.TaggedError<IntegrationPersistenceUnavailable>()(
  "IntegrationPersistenceUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.String,
  },
) {}

export class IntegrationArtifactUnavailable extends Schema.TaggedError<IntegrationArtifactUnavailable>()(
  "IntegrationArtifactUnavailable",
  {
    message: Schema.String,
    reason: Schema.Literals(["inaccessible", "identityMismatch", "mediaMismatch", "sizeMismatch"]),
  },
) {}

export class IntegrationConnectionUnavailable extends Schema.TaggedError<IntegrationConnectionUnavailable>()(
  "IntegrationConnectionUnavailable",
  {
    message: Schema.String,
    toolkit: Schema.String,
    userId: Schema.String,
  },
) {}

export class IntegrationExecutionRejected extends Schema.TaggedError<IntegrationExecutionRejected>()(
  "IntegrationExecutionRejected",
  {
    code: Schema.Literals(["conflict", "providerUnavailable", "resultInvalid"]),
    message: Schema.String,
    operation: Schema.String,
    providerLogId: Schema.optional(Schema.String),
    toolkit: Schema.String,
  },
) {}

export class IntegrationActionConflict extends Schema.TaggedError<IntegrationActionConflict>()(
  "IntegrationActionConflict",
  { actionId: Schema.String, message: Schema.String },
) {}

export class IntegrationActionAmbiguous extends Schema.TaggedError<IntegrationActionAmbiguous>()(
  "IntegrationActionAmbiguous",
  { actionId: Schema.String, message: Schema.String },
) {}

export type IntegrationConnectionEvidence =
  | {
      readonly _tag: "IntegrationConnectionConnected";
      readonly toolkit: string;
      readonly userId: UserId;
    }
  | {
      readonly _tag: "IntegrationConnectionMissing";
      readonly toolkit: string;
      readonly userId: UserId;
    }
  | {
      readonly _tag: "IntegrationConnectionStale";
      readonly toolkit: string;
      readonly userId: UserId;
    }
  | {
      readonly _tag: "IntegrationConnectionAmbiguous";
      readonly toolkit: string;
      readonly userId: UserId;
    };

export interface IntegrationReadCompleted {
  readonly _tag: "IntegrationReadCompleted";
  readonly evidence: { readonly providerLogId: string };
  readonly manifestVersion: ManifestVersion;
  readonly operation: string;
  readonly records: ReadonlyArray<Record<string, boolean | number | string | null>>;
  readonly responseBytes: bigint;
  readonly toolkit: string;
  readonly truncated: boolean;
}

export interface IntegrationEffectCompleted {
  readonly _tag: "IntegrationEffectCompleted";
  readonly evidence: { readonly providerLogId: string };
  readonly manifestVersion: ManifestVersion;
  readonly mutations: 1;
  readonly operation: string;
  readonly toolkit: string;
}

export interface ExecuteIntegrationInput<E> {
  readonly actionId?: ActionId;
  readonly authorize: Effect.Effect<void, E>;
  readonly identity: {
    readonly manifestVersion: ManifestVersion;
    readonly operation: string;
    readonly toolkit: string;
  };
  readonly input: unknown;
  readonly userId: UserId;
}

/** Deep Osfo-owned session, connection, manifest, and execution interface. */
export interface Interface {
  readonly connectLink: (input: {
    readonly callbackUrl: URL;
    readonly toolkit: string;
    readonly userId: UserId;
  }) => Effect.Effect<
    {
      readonly _tag: "IntegrationConnectLinkReady";
      readonly redirectUrl: URL;
      readonly toolkit: string;
      readonly userId: UserId;
    },
    | IntegrationManifestUnavailable
    | IntegrationPersistenceUnavailable
    | IntegrationProviderUnavailable
  >;
  readonly connectionEvidence: (input: {
    readonly toolkit: string;
    readonly userId: UserId;
  }) => Effect.Effect<
    IntegrationConnectionEvidence,
    | IntegrationManifestUnavailable
    | IntegrationPersistenceUnavailable
    | IntegrationProviderUnavailable
  >;
  readonly disconnect: (input: {
    readonly toolkit: string;
    readonly userId: UserId;
  }) => Effect.Effect<
    { readonly _tag: "IntegrationConnectionRevoked"; readonly toolkit: string },
    | IntegrationConnectionUnavailable
    | IntegrationManifestUnavailable
    | IntegrationPersistenceUnavailable
    | IntegrationProviderUnavailable
  >;
  readonly execute: <E>(
    input: ExecuteIntegrationInput<E>,
  ) => Effect.Effect<
    IntegrationEffectCompleted | IntegrationReadCompleted,
    | E
    | IntegrationActionAmbiguous
    | IntegrationActionConflict
    | IntegrationConnectionUnavailable
    | IntegrationExecutionRejected
    | IntegrationManifestUnavailable
    | IntegrationManifestValueInvalid
    | IntegrationPersistenceUnavailable
    | IntegrationProviderUnavailable
  >;
  readonly resolveSession: (userId: UserId) => Effect.Effect<
    {
      readonly _tag: "IntegrationSessionResolved";
      readonly resumed: boolean;
      readonly userId: UserId;
    },
    IntegrationPersistenceUnavailable | IntegrationProviderUnavailable
  >;
}

/** Construct the only Osfo path allowed to invoke direct Composio operations. */
export const make = (
  ports: IntegrationProvider & IntegrationPersistence & Partial<IntegrationArtifactAccess>,
): Interface => {
  const sessionLock = Semaphore.makeUnsafe(1);
  const actionLock = Semaphore.makeUnsafe(1);

  const resolveProviderSession = (userId: UserId) =>
    sessionLock.withPermits(1)(
      Effect.gen(function* () {
        const retained = yield* ports.readSession(userId);
        if (retained !== null) {
          const resumed = yield* ports.useSession(userId, retained).pipe(
            Effect.map((session) => ({ _tag: "Resumed" as const, session })),
            Effect.catchTag("IntegrationProviderUnavailable", (failure) =>
              failure.reason === "missing"
                ? Effect.succeed({ _tag: "Missing" as const })
                : Effect.fail(failure),
            ),
          );
          if (resumed._tag === "Resumed") {
            return { resumed: true, session: resumed.session } as const;
          }
          const created = yield* ports.createSession(userId, directIntegrationProviderConfig);
          const winner = yield* ports.replaceSession(userId, retained, created.providerSessionId);
          return winner === created.providerSessionId
            ? ({ resumed: false, session: created.session } as const)
            : ({ resumed: true, session: yield* ports.useSession(userId, winner) } as const);
        }
        const created = yield* ports.createSession(userId, directIntegrationProviderConfig);
        const winner = yield* ports.retainSession(userId, created.providerSessionId);
        return winner === created.providerSessionId
          ? ({ resumed: false, session: created.session } as const)
          : ({ resumed: true, session: yield* ports.useSession(userId, winner) } as const);
      }),
    );

  const inspectConnection = Effect.fn("Integrations.inspectConnection")(function* (input: {
    readonly toolkit: string;
    readonly userId: UserId;
  }) {
    if (!isSupportedToolkit(input.toolkit)) {
      return yield* unsupportedToolkit(input.toolkit, "CONNECTION_EVIDENCE");
    }
    const { session } = yield* resolveProviderSession(input.userId);
    const candidates = (yield* session.inspectToolkits([input.toolkit])).filter(
      ({ slug }) => slug === input.toolkit,
    );
    if (candidates.length > 1) {
      return connectionInspection(input, "IntegrationConnectionAmbiguous", session);
    }
    const candidate = candidates[0];
    if (candidate?.connectedAccount === null || candidate === undefined) {
      return connectionInspection(input, "IntegrationConnectionMissing", session);
    }
    if (!candidate.isActive || candidate.connectedAccount.status !== "ACTIVE") {
      return connectionInspection(input, "IntegrationConnectionStale", session);
    }
    return {
      connectedAccountId: candidate.connectedAccount.id,
      evidence: {
        _tag: "IntegrationConnectionConnected" as const,
        toolkit: input.toolkit,
        userId: input.userId,
      },
      session,
    };
  });

  const connectionEvidence = Effect.fn("Integrations.connectionEvidence")(function* (input: {
    readonly toolkit: string;
    readonly userId: UserId;
  }) {
    return (yield* inspectConnection(input)).evidence;
  });

  const requireConnection = (toolkit: string, userId: UserId) =>
    inspectConnection({ toolkit, userId }).pipe(
      Effect.flatMap((inspection) =>
        "connectedAccountId" in inspection
          ? Effect.succeed({
              connectedAccountId: inspection.connectedAccountId,
              session: inspection.session,
            })
          : Effect.fail(
              new IntegrationConnectionUnavailable({
                message: "The required Integration Connection is not current and unambiguous",
                toolkit,
                userId,
              }),
            ),
      ),
    );

  const execute = <E>(input: ExecuteIntegrationInput<E>) =>
    Effect.gen(function* () {
      const resolved = resolveManifest(input.identity);
      if (Result.isFailure(resolved)) return yield* resolved.failure;
      const manifest = resolved.success;
      const decoded = manifest.decodeInput(input.input);
      if (Result.isFailure(decoded)) return yield* decoded.failure;
      let providerInput = providerInputFor(manifest, decoded.success);
      if (manifest.operationKind === "read") {
        yield* input.authorize;
        const connection = yield* requireConnection(manifest.toolkit, input.userId);
        const execution = yield* connection.session.execute(
          manifest.providerTool,
          providerInput,
          connection.connectedAccountId,
        );
        return yield* normalizeRead(manifest, execution, decoded.success);
      }
      if (input.actionId === undefined) {
        return yield* new IntegrationActionConflict({
          actionId: "missing",
          message: "An integration effect requires one durable Osfo Action identity",
        });
      }
      const actionId = input.actionId;
      const digest = yield* actionDigest(manifest, decoded.success);
      return yield* actionLock.withPermits(1)(
        Effect.gen(function* () {
          yield* input.authorize;
          const retained = yield* ports.readAction(actionId);
          if (retained?._tag === "Applied" && retained.digest === digest) return retained.result;
          if (retained !== null && retained.digest !== digest) {
            return yield* new IntegrationActionConflict({
              actionId,
              message: "The Action identity is already bound to different integration facts",
            });
          }
          if (retained?._tag === "Pending" || retained?._tag === "Ambiguous") {
            return yield* new IntegrationActionAmbiguous({
              actionId,
              message: "The integration Action has an unresolved provider outcome",
            });
          }
          const connection = yield* requireConnection(manifest.toolkit, input.userId);
          if (manifest.operation === "DRIVE_DELIVER_ARTIFACT") {
            const request = yield* Schema.decodeUnknownEffect(DriveDeliverArtifactInput)(
              decoded.success,
            ).pipe(
              Effect.mapError(
                () =>
                  new IntegrationExecutionRejected({
                    code: "resultInvalid",
                    message: "The approved artifact delivery input is invalid",
                    operation: manifest.operation,
                    toolkit: manifest.toolkit,
                  }),
              ),
            );
            if (ports.readOwned === undefined) {
              return yield* new IntegrationExecutionRejected({
                code: "providerUnavailable",
                message: "Owned artifact delivery is unavailable",
                operation: manifest.operation,
                toolkit: manifest.toolkit,
              });
            }
            const artifact = yield* ports.readOwned({ ...request, userId: input.userId }).pipe(
              Effect.mapError(
                () =>
                  new IntegrationExecutionRejected({
                    code: "resultInvalid",
                    message: "The owned artifact does not match the approved delivery",
                    operation: manifest.operation,
                    toolkit: manifest.toolkit,
                  }),
              ),
            );
            const staged = yield* connection.session.stageFile(artifact);
            providerInput = {
              file_to_upload: staged,
              folder_to_upload_to: request.targetFolderId,
            };
          }
          yield* ports.retainAction(actionId, { _tag: "Pending", digest });
          const attempted = yield* Effect.exit(
            connection.session.execute(
              manifest.providerTool,
              providerInput,
              connection.connectedAccountId,
            ),
          );
          if (Predicate.isTagged(attempted, "Failure")) {
            yield* ports.retainAction(actionId, { _tag: "Ambiguous", digest });
            return yield* new IntegrationActionAmbiguous({
              actionId,
              message: "The integration provider outcome is unknown",
            });
          }
          if (attempted.value.error !== null) {
            yield* ports.retainAction(actionId, { _tag: "NotApplied", digest });
            return yield* providerRejection(manifest, attempted.value);
          }
          const result = yield* normalizeEffect(manifest, attempted.value).pipe(
            Effect.tapError(() => ports.retainAction(actionId, { _tag: "Ambiguous", digest })),
          );
          yield* ports.retainAction(actionId, { _tag: "Applied", digest, result });
          return result;
        }),
      );
    });

  return {
    connectLink: Effect.fn("Integrations.connectLink")(function* (input) {
      if (!isSupportedToolkit(input.toolkit))
        return yield* unsupportedToolkit(input.toolkit, "CONNECT");
      const { session } = yield* resolveProviderSession(input.userId);
      return {
        _tag: "IntegrationConnectLinkReady" as const,
        redirectUrl: yield* session.authorize(input.toolkit, input.callbackUrl),
        toolkit: input.toolkit,
        userId: input.userId,
      };
    }),
    connectionEvidence,
    disconnect: Effect.fn("Integrations.disconnect")(function* (input) {
      const connection = yield* requireConnection(input.toolkit, input.userId);
      yield* connection.session.disconnect(connection.connectedAccountId);
      return { _tag: "IntegrationConnectionRevoked" as const, toolkit: input.toolkit };
    }),
    execute,
    resolveSession: Effect.fn("Integrations.resolveSession")(function* (userId) {
      const resolved = yield* resolveProviderSession(userId);
      return {
        _tag: "IntegrationSessionResolved" as const,
        resumed: resolved.resumed,
        userId,
      };
    }),
  };
};

const connectionInspection = (
  input: { readonly toolkit: string; readonly userId: UserId },
  tag:
    | "IntegrationConnectionAmbiguous"
    | "IntegrationConnectionMissing"
    | "IntegrationConnectionStale",
  session: ProviderSession,
) => ({
  evidence: { _tag: tag, toolkit: input.toolkit, userId: input.userId },
  session,
});

const providerInputFor = (
  manifest: ResolvedIntegrationManifestOperation,
  input: Schema.Json,
): ProviderInput => {
  switch (manifest.operation) {
    case "GMAIL_SEARCH_EMAILS": {
      const value = Schema.decodeUnknownSync(GmailSearchInput)(input);
      return {
        ids_only: false,
        include_payload: false,
        include_spam_trash: value.includeSpamTrash,
        max_results: value.maximumMessages,
        query: value.query,
        user_id: "me",
        verbose: false,
      };
    }
    case "GMAIL_FETCH_THREAD": {
      const value = Schema.decodeUnknownSync(GmailFetchThreadInput)(input);
      return { thread_id: value.threadId, user_id: "me" };
    }
    case "GMAIL_SEND_EMAIL": {
      const value = Schema.decodeUnknownSync(GmailMessageInput)(input);
      const [recipient, ...extraRecipients] = value.recipients;
      const common = {
        body: value.body,
        is_html: false,
        recipient_email: recipient,
        subject: value.subject,
        user_id: "me",
      } as const;
      return extraRecipients.length === 0
        ? common
        : { ...common, extra_recipients: extraRecipients };
    }
    case "CALENDAR_LIST_EVENTS": {
      const value = Schema.decodeUnknownSync(CalendarListEventsInput)(input);
      return {
        calendarId: value.calendarId,
        maxResults: value.maximumEvents,
        showDeleted: false,
        singleEvents: true,
        timeMax: value.endsAt,
        timeMin: value.startsAt,
        timeZone: value.timeZone,
      };
    }
    case "CALENDAR_FIND_AVAILABILITY": {
      const value = Schema.decodeUnknownSync(CalendarAvailabilityInput)(input);
      return {
        calendar_expansion_max: 1,
        group_expansion_max: 1,
        items: [value.calendarId],
        time_max: value.endsAt,
        time_min: value.startsAt,
        timezone: value.timeZone,
      };
    }
    case "CALENDAR_CREATE_EVENT": {
      const value = Schema.decodeUnknownSync(CalendarCreateEventInput)(input);
      const common = {
        attendees: [],
        calendar_id: value.calendarId,
        create_meeting_room: false,
        end_datetime: value.endsAt,
        exclude_organizer: true,
        send_updates: "none",
        start_datetime: value.startsAt,
        summary: value.title,
        timezone: value.timeZone,
        visibility: "private",
      } as const;
      const recurrence = calendarRecurrence(value.recurrence);
      return recurrence === undefined ? common : { ...common, recurrence };
    }
    case "CALENDAR_DELETE_EVENT": {
      const value = Schema.decodeUnknownSync(CalendarDeleteEventInput)(input);
      return {
        calendar_id: value.calendarId,
        event_id: value.eventId,
        send_updates: "none",
      };
    }
    case "DRIVE_SEARCH": {
      const value = Schema.decodeUnknownSync(DriveSearchInput)(input);
      return {
        corpora: "user",
        fields: "files(id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,trashed)",
        includeItemsFromAllDrives: false,
        pageSize: value.maximumFiles,
        q: `(${value.query}) and 'me' in owners and trashed = false`,
        spaces: "drive",
        supportsAllDrives: false,
      };
    }
    case "CALENDAR_UPDATE_EVENT": {
      const value = Schema.decodeUnknownSync(CalendarUpdateEventInput)(input);
      return {
        calendar_id: value.calendarId,
        event_id: value.eventId,
        send_updates: "none",
        ...calendarPatchInput(value.changes),
      };
    }
    case "DRIVE_GET_METADATA": {
      const value = Schema.decodeUnknownSync(DriveGetMetadataInput)(input);
      return {
        fields: "id,name,mimeType,size,modifiedTime,webViewLink",
        fileId: value.fileId,
        supportsAllDrives: true,
      };
    }
    case "DRIVE_READ_FILE": {
      const value = Schema.decodeUnknownSync(DriveReadFileInput)(input);
      return { file_id: value.fileId, mime_type: value.expectedMediaType };
    }
    case "DRIVE_DELIVER_ARTIFACT": {
      const value = Schema.decodeUnknownSync(DriveDeliverArtifactInput)(input);
      return {
        file_to_upload: {
          mimetype: value.mediaType,
          name: value.fileName,
          s3key: value.artifactId,
        },
        folder_to_upload_to: value.targetFolderId,
      };
    }
    default:
      throw new Error(`Unsupported retained integration operation: ${manifest.operation}`);
  }
};

interface CalendarPatchInput {
  description?: string;
  end_time?: string;
  location?: string;
  recurrence?: ReadonlyArray<string>;
  start_time?: string;
  summary?: string;
  timezone?: string;
}

const calendarPatchInput = (
  changes: typeof CalendarUpdateEventInput.Type.changes,
): CalendarPatchInput => {
  const patch: CalendarPatchInput = {};
  if (changes.description !== undefined) patch.description = changes.description;
  if (changes.endsAt !== undefined) patch.end_time = changes.endsAt;
  if (changes.location !== undefined) patch.location = changes.location;
  if (changes.recurrence !== undefined) {
    patch.recurrence = calendarRecurrence(changes.recurrence) ?? [];
  }
  if (changes.startsAt !== undefined) patch.start_time = changes.startsAt;
  if (changes.timeZone !== undefined) patch.timezone = changes.timeZone;
  if (changes.title !== undefined) patch.summary = changes.title;
  return patch;
};

const calendarRecurrence = (
  recurrence: typeof CalendarCreateEventInput.Type.recurrence,
): ReadonlyArray<string> | undefined => {
  if (recurrence === null) return undefined;
  return [
    `RRULE:FREQ=${recurrence.frequency};INTERVAL=${recurrence.interval};COUNT=${recurrence.count}`,
  ];
};

const normalizeRead = (
  manifest: ResolvedIntegrationManifestOperation,
  execution: ProviderExecutionResult,
  input: Schema.Json,
) =>
  Effect.gen(function* () {
    const providerLogId = yield* validateProviderResult(manifest, execution);
    const candidates = yield* readCandidates(manifest, execution.data);
    const records: Array<Record<string, boolean | number | string | null>> = [];
    let truncated = candidates.length > manifest.hardBounds.maximumRecords;
    for (const candidate of candidates.slice(0, manifest.hardBounds.maximumRecords)) {
      const projected = yield* projectSafeRecord(manifest, candidate);
      const bounded = boundProjectedRecord(manifest.operation, projected, input);
      const next = [...records, bounded];
      if (byteLength(next) > manifest.hardBounds.maximumResponseBytes) {
        truncated = true;
        break;
      }
      records.push(bounded);
    }
    const responseBytes = byteLength(records);
    return {
      _tag: "IntegrationReadCompleted" as const,
      evidence: { providerLogId },
      manifestVersion: manifest.manifestVersion,
      operation: manifest.operation,
      records,
      responseBytes,
      toolkit: manifest.toolkit,
      truncated,
    };
  });

const boundProjectedRecord = (
  operation: string,
  record: Record<string, boolean | number | string | null>,
  input: Schema.Json,
) => {
  if (operation !== "DRIVE_READ_FILE" || !Predicate.isString(record.content)) return record;
  const maximumBytes = Schema.decodeUnknownSync(DriveReadFileInput)(input).maximumBytes;
  const encoded = new TextEncoder().encode(record.content);
  if (encoded.byteLength <= maximumBytes) return record;
  return {
    ...record,
    content: decodeUtf8Prefix(encoded, maximumBytes),
    truncated: true,
  };
};

const decodeUtf8Prefix = (bytes: Uint8Array, maximumBytes: number) => {
  for (let end = maximumBytes; end >= Math.max(0, maximumBytes - 3); end -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        bytes.slice(0, end),
      );
    } catch {
      // Continue to the previous complete UTF-8 code point.
    }
  }
  return "";
};

const normalizeEffect = (
  manifest: ResolvedIntegrationManifestOperation,
  execution: ProviderExecutionResult,
) =>
  Effect.gen(function* () {
    const providerLogId = yield* validateProviderResult(manifest, execution);
    return {
      _tag: "IntegrationEffectCompleted" as const,
      evidence: { providerLogId },
      manifestVersion: manifest.manifestVersion,
      mutations: 1 as const,
      operation: manifest.operation,
      toolkit: manifest.toolkit,
    };
  });

const validateProviderResult = (
  manifest: ResolvedIntegrationManifestOperation,
  execution: ProviderExecutionResult,
) => {
  const providerLogId = execution.logId.trim();
  if (execution.error !== null) {
    return Effect.fail(providerRejection(manifest, execution));
  }
  if (providerLogId.length === 0 || providerLogId.length > 500) {
    return Effect.fail(
      new IntegrationExecutionRejected({
        code: "resultInvalid",
        message: "The integration provider returned invalid execution evidence",
        operation: manifest.operation,
        toolkit: manifest.toolkit,
      }),
    );
  }
  return Effect.succeed(providerLogId);
};

const providerRejection = (
  manifest: ResolvedIntegrationManifestOperation,
  execution: ProviderExecutionResult,
) => {
  const providerLogId = execution.logId.trim();
  const conflict =
    manifest.toolkit === "googlecalendar" && /\bconflict\b/iu.test(execution.error ?? "");
  const common = {
    code: conflict ? ("conflict" as const) : ("providerUnavailable" as const),
    message: conflict
      ? "The Calendar operation conflicts with current provider state"
      : "The integration provider rejected the operation",
    operation: manifest.operation,
    toolkit: manifest.toolkit,
  } as const;
  return providerLogId.length > 0 && providerLogId.length <= 500
    ? new IntegrationExecutionRejected({ ...common, providerLogId })
    : new IntegrationExecutionRejected(common);
};

const readCandidates = (
  manifest: ResolvedIntegrationManifestOperation,
  data: Schema.JsonObject,
): Effect.Effect<ReadonlyArray<Schema.Json>, IntegrationExecutionRejected> => {
  if (manifest.outputContract === "driveMetadataV1" || manifest.outputContract === "driveContentV1")
    return Effect.succeed([data]);
  const candidateKeys = (() => {
    switch (manifest.outputContract) {
      case "gmailMessagesV1":
      case "gmailThreadV1":
        return ["messages", "items"];
      case "calendarAvailabilityV1":
        return ["freeSlots", "busy", "items"];
      case "driveFilesV1":
        return ["files", "items"];
      case "calendarEventsV1":
        return ["items", "events"];
      default:
        return [];
    }
  })();
  for (const key of candidateKeys) {
    const candidate = Schema.decodeUnknownOption(Schema.Array(Schema.Json))(data[key]);
    if (Option.isSome(candidate)) return Effect.succeed(candidate.value);
  }
  return Effect.fail(invalidProviderResult(manifest));
};

const safeFields = {
  CALENDAR_FIND_AVAILABILITY: ["calendarId", "end", "start", "timeMax", "timeMin"],
  CALENDAR_LIST_EVENTS: [
    "description",
    "end",
    "eventId",
    "id",
    "location",
    "start",
    "status",
    "summary",
  ],
  DRIVE_GET_METADATA: ["id", "mimeType", "modifiedTime", "name", "size", "webViewLink"],
  DRIVE_READ_FILE: ["content", "fileId", "mimeType", "name", "size", "truncated"],
  DRIVE_SEARCH: [
    "createdTime",
    "id",
    "mimeType",
    "modifiedTime",
    "name",
    "size",
    "trashed",
    "webViewLink",
  ],
  GMAIL_FETCH_THREAD: ["body", "date", "from", "id", "snippet", "subject", "threadId", "to"],
  GMAIL_SEARCH_EMAILS: ["date", "from", "id", "snippet", "subject", "threadId", "to"],
} as const;

const projectSafeRecord = (
  manifest: ResolvedIntegrationManifestOperation,
  candidate: Schema.Json,
): Effect.Effect<
  Record<string, boolean | number | string | null>,
  IntegrationExecutionRejected
> => {
  const source = Schema.decodeUnknownOption(Schema.JsonObject)(candidate);
  if (Option.isNone(source)) return Effect.fail(invalidProviderResult(manifest));
  const fields = safeFieldsFor(manifest.operation);
  const projected: Record<string, boolean | number | string | null> = {};
  for (const field of fields) {
    const value = Schema.decodeUnknownOption(SafeScalar)(source.value[field]);
    if (Option.isNone(value)) continue;
    if (Predicate.isString(value.value)) {
      projected[field] = value.value.slice(
        0,
        field === "body" || field === "description" ? 2_500 : 1_000,
      );
      continue;
    }
    projected[field] = value.value;
  }
  return Object.keys(projected).length > 0
    ? Effect.succeed(projected)
    : Effect.fail(invalidProviderResult(manifest));
};

const SafeScalar = Schema.Union([Schema.Null, Schema.Boolean, Schema.Finite, Schema.String]);

const safeFieldsFor = (operation: string): ReadonlyArray<string> => {
  switch (operation) {
    case "CALENDAR_FIND_AVAILABILITY":
      return safeFields.CALENDAR_FIND_AVAILABILITY;
    case "CALENDAR_LIST_EVENTS":
      return safeFields.CALENDAR_LIST_EVENTS;
    case "DRIVE_GET_METADATA":
      return safeFields.DRIVE_GET_METADATA;
    case "DRIVE_READ_FILE":
      return safeFields.DRIVE_READ_FILE;
    case "DRIVE_SEARCH":
      return safeFields.DRIVE_SEARCH;
    case "GMAIL_FETCH_THREAD":
      return safeFields.GMAIL_FETCH_THREAD;
    case "GMAIL_SEARCH_EMAILS":
      return safeFields.GMAIL_SEARCH_EMAILS;
    default:
      return [];
  }
};

const invalidProviderResult = (manifest: ResolvedIntegrationManifestOperation) =>
  new IntegrationExecutionRejected({
    code: "resultInvalid",
    message: "The integration provider returned a result outside the manifest output contract",
    operation: manifest.operation,
    toolkit: manifest.toolkit,
  });

const isSupportedToolkit = (value: string): boolean =>
  directIntegrationProviderConfig.toolkits.some((toolkit) => toolkit === value);

const unsupportedToolkit = (toolkit: string, operation: string) =>
  new IntegrationManifestUnavailable({
    manifestVersion: ManifestVersion.make("connect-v1"),
    operation,
    toolkit,
  });

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

const byteLength = (value: Schema.Json): bigint =>
  BigInt(new TextEncoder().encode(encodeJson(value)).byteLength);

const ActionDigestFacts = Schema.Struct({
  input: Schema.Json,
  manifestVersion: ManifestVersion,
  operation: Schema.String,
  toolkit: Schema.String,
});
const encodeActionDigestFacts = Schema.encodeSync(Schema.fromJsonString(ActionDigestFacts));

const actionDigest = (
  manifest: ResolvedIntegrationManifestOperation,
  input: Schema.Json,
): Effect.Effect<string, IntegrationPersistenceUnavailable> =>
  Effect.tryPromise({
    try: () => {
      const encoded = new TextEncoder().encode(
        encodeActionDigestFacts({
          input,
          manifestVersion: manifest.manifestVersion,
          operation: manifest.operation,
          toolkit: manifest.toolkit,
        }),
      );
      return crypto.subtle
        .digest("SHA-256", encoded)
        .then((digest) =>
          [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
        );
    },
    catch: (cause) =>
      new IntegrationPersistenceUnavailable({
        cause,
        message: "The Action identity digest could not be computed",
        operation: "digestAction",
      }),
  });

export * as Integrations from "./integrations";
