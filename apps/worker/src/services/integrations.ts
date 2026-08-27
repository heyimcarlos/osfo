import { Effect, Option, Predicate, Result, Schema, Semaphore } from "effect";

import type { ActionId } from "../domain/action-execution";
import { ManifestVersion, type UserId } from "../domain";
import {
  CalendarCreatePrivateInput,
  CalendarListEventsInput,
  CalendarUpdateEventInput,
  DriveGetMetadataInput,
  GmailFetchThreadInput,
  GmailMessageInput,
  IntegrationManifestUnavailable,
  resolveManifest,
  type IntegrationManifestValueInvalid,
  type ResolvedIntegrationManifestOperation,
} from "../domain/integration-manifest";

/* oxlint-disable eslint/no-underscore-dangle -- Integration outcomes use the repository's _tag discriminator. */

const providerTools = [
  "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
  "GMAIL_CREATE_EMAIL_DRAFT",
  "GMAIL_SEND_EMAIL",
  "GOOGLECALENDAR_EVENTS_LIST",
  "GOOGLECALENDAR_CREATE_EVENT",
  "GOOGLECALENDAR_PATCH_EVENT",
  "GOOGLEDRIVE_GET_FILE_METADATA",
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
    }
  | {
      readonly attendees: [];
      readonly calendar_id: string;
      readonly create_meeting_room: false;
      readonly end_datetime: string;
      readonly send_updates: "none";
      readonly start_datetime: string;
      readonly summary: string;
      readonly visibility: "private";
    }
  | ({
      readonly calendar_id: string;
      readonly event_id: string;
      readonly send_updates: "none";
    } & CalendarPatchInput)
  | {
      readonly fields: "id,name,mimeType,size,modifiedTime,webViewLink";
      readonly fileId: string;
      readonly supportsAllDrives: true;
    };

/** Narrow Composio boundary. Meta tools, arbitrary discovery, and sandbox APIs are absent. */
export interface ProviderSession {
  readonly authorize: (
    toolkit: string,
    callbackUrl: URL,
  ) => Effect.Effect<URL, IntegrationProviderUnavailable>;
  readonly execute: (
    providerTool: string,
    input: ProviderInput,
  ) => Effect.Effect<ProviderExecutionResult, IntegrationProviderUnavailable>;
  readonly inspectToolkits: (
    toolkits: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<ProviderToolkitEvidence>, IntegrationProviderUnavailable>;
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
    code: Schema.Literals(["providerUnavailable", "resultInvalid"]),
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
export const make = (ports: IntegrationProvider & IntegrationPersistence): Interface => {
  const sessionLock = Semaphore.makeUnsafe(1);
  const actionLock = Semaphore.makeUnsafe(1);

  const resolveProviderSession = (userId: UserId) =>
    sessionLock.withPermits(1)(
      Effect.gen(function* () {
        const retained = yield* ports.readSession(userId);
        if (retained !== null) {
          const resumed = yield* ports.useSession(retained).pipe(
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
            : ({ resumed: true, session: yield* ports.useSession(winner) } as const);
        }
        const created = yield* ports.createSession(userId, directIntegrationProviderConfig);
        const winner = yield* ports.retainSession(userId, created.providerSessionId);
        return winner === created.providerSessionId
          ? ({ resumed: false, session: created.session } as const)
          : ({ resumed: true, session: yield* ports.useSession(winner) } as const);
      }),
    );

  const connectionEvidence = Effect.fn("Integrations.connectionEvidence")(function* (input: {
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
      return {
        _tag: "IntegrationConnectionAmbiguous" as const,
        toolkit: input.toolkit,
        userId: input.userId,
      };
    }
    const candidate = candidates[0];
    if (candidate?.connectedAccount === null || candidate === undefined) {
      return {
        _tag: "IntegrationConnectionMissing" as const,
        toolkit: input.toolkit,
        userId: input.userId,
      };
    }
    if (!candidate.isActive || candidate.connectedAccount.status !== "ACTIVE") {
      return {
        _tag: "IntegrationConnectionStale" as const,
        toolkit: input.toolkit,
        userId: input.userId,
      };
    }
    return {
      _tag: "IntegrationConnectionConnected" as const,
      toolkit: input.toolkit,
      userId: input.userId,
    };
  });

  const execute = <E>(input: ExecuteIntegrationInput<E>) =>
    Effect.gen(function* () {
      const resolved = resolveManifest(input.identity);
      if (Result.isFailure(resolved)) return yield* resolved.failure;
      const manifest = resolved.success;
      const decoded = manifest.decodeInput(input.input);
      if (Result.isFailure(decoded)) return yield* decoded.failure;
      const connection = yield* connectionEvidence({
        toolkit: manifest.toolkit,
        userId: input.userId,
      });
      if (connection._tag !== "IntegrationConnectionConnected") {
        return yield* new IntegrationConnectionUnavailable({
          message: "The required Integration Connection is not current and unambiguous",
          toolkit: manifest.toolkit,
          userId: input.userId,
        });
      }
      const { session } = yield* resolveProviderSession(input.userId);
      const providerInput = providerInputFor(manifest, decoded.success);
      yield* input.authorize;
      if (manifest.operationKind === "read") {
        const execution = yield* session.execute(manifest.providerTool, providerInput);
        return yield* normalizeRead(manifest, execution);
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
          yield* ports.retainAction(actionId, { _tag: "Pending", digest });
          const attempted = yield* Effect.exit(
            session.execute(manifest.providerTool, providerInput),
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

const providerInputFor = (
  manifest: ResolvedIntegrationManifestOperation,
  input: Schema.Json,
): ProviderInput => {
  switch (manifest.operation) {
    case "GMAIL_FETCH_THREAD": {
      const value = Schema.decodeUnknownSync(GmailFetchThreadInput)(input);
      return { thread_id: value.threadId, user_id: "me" };
    }
    case "GMAIL_CREATE_DRAFT":
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
      };
    }
    case "CALENDAR_CREATE_PRIVATE": {
      const value = Schema.decodeUnknownSync(CalendarCreatePrivateInput)(input);
      return {
        attendees: [],
        calendar_id: value.calendarId,
        create_meeting_room: false,
        end_datetime: value.endsAt,
        send_updates: "none",
        start_datetime: value.startsAt,
        summary: value.title,
        visibility: "private",
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
    default:
      throw new Error(`Unsupported retained integration operation: ${manifest.operation}`);
  }
};

interface CalendarPatchInput {
  description?: string;
  end_time?: string;
  location?: string;
  start_time?: string;
  summary?: string;
}

const calendarPatchInput = (
  changes: typeof CalendarUpdateEventInput.Type.changes,
): CalendarPatchInput => {
  const patch: CalendarPatchInput = {};
  if (changes.description !== undefined) patch.description = changes.description;
  if (changes.endsAt !== undefined) patch.end_time = changes.endsAt;
  if (changes.location !== undefined) patch.location = changes.location;
  if (changes.startsAt !== undefined) patch.start_time = changes.startsAt;
  if (changes.title !== undefined) patch.summary = changes.title;
  return patch;
};

const normalizeRead = (
  manifest: ResolvedIntegrationManifestOperation,
  execution: ProviderExecutionResult,
) =>
  Effect.gen(function* () {
    const providerLogId = yield* validateProviderResult(manifest, execution);
    const candidates = yield* readCandidates(manifest, execution.data);
    const records: Array<Record<string, boolean | number | string | null>> = [];
    let truncated = candidates.length > manifest.hardBounds.maximumRecords;
    for (const candidate of candidates.slice(0, manifest.hardBounds.maximumRecords)) {
      const projected = yield* projectSafeRecord(manifest, candidate);
      const next = [...records, projected];
      if (byteLength(next) > manifest.hardBounds.maximumResponseBytes) {
        truncated = true;
        break;
      }
      records.push(projected);
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
  const common = {
    code: "providerUnavailable",
    message: "The integration provider rejected the operation",
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
  if (manifest.outputContract === "driveMetadataV1") return Effect.succeed([data]);
  for (const key of manifest.outputContract === "gmailThreadV1"
    ? ["messages", "items"]
    : ["items", "events"]) {
    const candidate = Schema.decodeUnknownOption(Schema.Array(Schema.Json))(data[key]);
    if (Option.isSome(candidate)) return Effect.succeed(candidate.value);
  }
  return Effect.fail(invalidProviderResult(manifest));
};

const safeFields = {
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
  GMAIL_FETCH_THREAD: ["body", "date", "from", "id", "snippet", "subject", "threadId", "to"],
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
    case "CALENDAR_LIST_EVENTS":
      return safeFields.CALENDAR_LIST_EVENTS;
    case "DRIVE_GET_METADATA":
      return safeFields.DRIVE_GET_METADATA;
    case "GMAIL_FETCH_THREAD":
      return safeFields.GMAIL_FETCH_THREAD;
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
