import { Clock, Effect, Option, Predicate, Result, Schema, Semaphore } from "effect";

import type { ActionId } from "../domain/action-execution";
import { ManifestVersion, type UserId } from "../domain";
import {
  CalendarDeleteEventInput,
  CalendarUpdateEventInput,
  DriveDeliverArtifactInput,
  DriveGetMetadataInput,
  DriveReadFileInput,
  IntegrationManifestUnavailable,
  resolveManifest,
  type IntegrationManifestValueInvalid,
  type ResolvedIntegrationManifestOperation,
} from "../domain/integration-manifest";
import {
  providerConstraintsFor,
  providerInputFor,
  type ProviderExecutionConstraints,
  type ProviderInput,
} from "./integration-provider-input";

export type { ProviderInput } from "./integration-provider-input";

/* oxlint-disable effecttsgo/crypto-random-uuid-in-effect -- Provider request UUIDs are opaque durable attempt identities, not deterministic test inputs. */
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
export const initialActionReconciliationDelayMilliseconds = 120_000;
export const providerEvidenceHorizonMilliseconds = 300_000;

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
  readonly supportingLogIds?: ReadonlyArray<string>;
}

export type ProviderExecutionEvidence =
  | { readonly _tag: "Applied"; readonly execution: ProviderExecutionResult }
  | { readonly _tag: "NotApplied"; readonly providerLogId: string }
  | { readonly _tag: "Unknown" };

export interface ProviderAttemptCorrelation {
  readonly connectedAccountId: string;
  readonly providerRequestId: string | null;
  readonly providerSessionId: string | null;
  readonly providerTool: string;
  readonly startedAt: number;
}

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
    constraints?: ProviderExecutionConstraints,
    correlation?: ProviderAttemptCorrelation,
  ) => Effect.Effect<ProviderExecutionResult, IntegrationProviderUnavailable>;
  readonly disconnect: (
    connectedAccountId: string,
  ) => Effect.Effect<void, IntegrationProviderUnavailable>;
  readonly inspectToolkits: (
    toolkits: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<ProviderToolkitEvidence>, IntegrationProviderUnavailable>;
  readonly inspectExecution?: (
    correlation: ProviderAttemptCorrelation,
    input: ProviderInput,
  ) => Effect.Effect<ProviderExecutionEvidence, IntegrationProviderUnavailable>;
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
  | {
      readonly _tag: "Pending";
      readonly correlation: ProviderAttemptCorrelation | null;
      readonly digest: string;
    }
  | {
      readonly _tag: "Ambiguous";
      readonly correlation: ProviderAttemptCorrelation | null;
      readonly digest: string;
    }
  | {
      readonly _tag: "TerminalAmbiguous";
      readonly correlation: ProviderAttemptCorrelation;
      readonly digest: string;
    }
  | { readonly _tag: "NotApplied"; readonly digest: string; readonly providerLogId: string | null }
  | {
      readonly _tag: "Applied";
      readonly digest: string;
      readonly providerRequestId: string | null;
      readonly result: IntegrationEffectCompleted;
    };

export type PersistedIntegrationActionSettlement = Extract<
  PersistedIntegrationAction,
  { readonly _tag: "Applied" | "NotApplied" }
>;

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
  readonly settleAction: (
    actionId: ActionId,
    providerRequestId: string,
    value: PersistedIntegrationActionSettlement,
  ) => Effect.Effect<PersistedIntegrationAction, IntegrationPersistenceUnavailable>;
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

export class IntegrationActionNotApplied extends Schema.TaggedError<IntegrationActionNotApplied>()(
  "IntegrationActionNotApplied",
  { actionId: Schema.String, message: Schema.String, providerLogId: Schema.NullOr(Schema.String) },
) {}

export class IntegrationEffectFinalizationUnavailable extends Schema.TaggedError<IntegrationEffectFinalizationUnavailable>()(
  "IntegrationEffectFinalizationUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

export const IntegrationConnectionBinding = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u),
).pipe(Schema.brand("IntegrationConnectionBinding"));
export type IntegrationConnectionBinding = typeof IntegrationConnectionBinding.Type;

export type IntegrationConnectionEvidence =
  | {
      readonly _tag: "IntegrationConnectionConnected";
      readonly connectionBinding: IntegrationConnectionBinding;
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
  readonly evidence: { readonly providerLogIds: ReadonlyArray<string> };
  readonly manifestVersion: ManifestVersion;
  readonly operation: string;
  readonly records: ReadonlyArray<Record<string, boolean | number | string | null>>;
  readonly responseBytes: bigint;
  readonly toolkit: string;
  readonly truncated: boolean;
}

export interface IntegrationEffectCompleted {
  readonly _tag: "IntegrationEffectCompleted";
  readonly evidence: { readonly providerLogId: string; readonly providerResourceId: string };
  readonly manifestVersion: ManifestVersion;
  readonly mutations: 1;
  readonly operation: string;
  readonly toolkit: string;
}

export type IntegrationEffectFinalOutcome =
  | { readonly _tag: "Applied"; readonly result: IntegrationEffectCompleted }
  | { readonly _tag: "NotApplied"; readonly providerLogId: string | null }
  | { readonly _tag: "Ambiguous" };

export interface ExecuteIntegrationInput<E, F = never> {
  readonly actionId?: ActionId;
  readonly authorize: Effect.Effect<void, E>;
  readonly finalizeEffect?: (outcome: IntegrationEffectFinalOutcome) => Effect.Effect<void, F>;
  readonly identity: {
    readonly manifestVersion: ManifestVersion;
    readonly operation: string;
    readonly toolkit: string;
  };
  readonly input: unknown;
  readonly userId: UserId;
}

export interface InspectIntegrationActionInput<F = never> {
  readonly actionId: ActionId;
  readonly finalizeEffect?: ExecuteIntegrationInput<never, F>["finalizeEffect"];
  readonly identity: ExecuteIntegrationInput<never>["identity"];
  readonly input: unknown;
  readonly userId: UserId;
}

export type IntegrationActionInspection =
  | { readonly _tag: "NotStarted" }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Ambiguous"; readonly retryAfterMilliseconds: number }
  | { readonly _tag: "TerminalAmbiguous" }
  | { readonly _tag: "NotApplied"; readonly providerLogId: string | null }
  | { readonly _tag: "Applied"; readonly result: IntegrationEffectCompleted };

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
  readonly execute: <E, F = never>(
    input: ExecuteIntegrationInput<E, F>,
  ) => Effect.Effect<
    IntegrationEffectCompleted | IntegrationReadCompleted,
    | E
    | F
    | IntegrationActionAmbiguous
    | IntegrationActionConflict
    | IntegrationActionNotApplied
    | IntegrationConnectionUnavailable
    | IntegrationExecutionRejected
    | IntegrationManifestUnavailable
    | IntegrationManifestValueInvalid
    | IntegrationPersistenceUnavailable
    | IntegrationProviderUnavailable
  >;
  readonly inspectAction: <F = never>(
    input: InspectIntegrationActionInput<F>,
  ) => Effect.Effect<
    IntegrationActionInspection,
    | F
    | IntegrationActionConflict
    | IntegrationExecutionRejected
    | IntegrationManifestUnavailable
    | IntegrationManifestValueInvalid
    | IntegrationPersistenceUnavailable
    | IntegrationProviderUnavailable
  >;
  readonly readActionStatus: (
    input: Omit<InspectIntegrationActionInput, "finalizeEffect" | "userId">,
  ) => Effect.Effect<
    IntegrationActionInspection,
    | IntegrationActionConflict
    | IntegrationManifestUnavailable
    | IntegrationManifestValueInvalid
    | IntegrationPersistenceUnavailable
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
            return {
              providerSessionId: retained,
              resumed: true,
              session: resumed.session,
            } as const;
          }
          const created = yield* ports.createSession(userId, directIntegrationProviderConfig);
          const winner = yield* ports.replaceSession(userId, retained, created.providerSessionId);
          return winner === created.providerSessionId
            ? ({
                providerSessionId: created.providerSessionId,
                resumed: false,
                session: created.session,
              } as const)
            : ({
                providerSessionId: winner,
                resumed: true,
                session: yield* ports.useSession(userId, winner),
              } as const);
        }
        const created = yield* ports.createSession(userId, directIntegrationProviderConfig);
        const winner = yield* ports.retainSession(userId, created.providerSessionId);
        return winner === created.providerSessionId
          ? ({
              providerSessionId: created.providerSessionId,
              resumed: false,
              session: created.session,
            } as const)
          : ({
              providerSessionId: winner,
              resumed: true,
              session: yield* ports.useSession(userId, winner),
            } as const);
      }),
    );

  const inspectConnectionInSession = Effect.fn("Integrations.inspectConnectionInSession")(
    function* (
      input: { readonly toolkit: string; readonly userId: UserId },
      session: ProviderSession,
    ) {
      const candidates = (yield* session.inspectToolkits([input.toolkit])).filter(
        ({ slug }) => slug === input.toolkit,
      );
      const active = candidates.filter(
        (candidate) => candidate.isActive && candidate.connectedAccount?.status === "ACTIVE",
      );
      if (active.length > 1) {
        return connectionInspection(input, "IntegrationConnectionAmbiguous", session);
      }
      const candidate = active[0];
      if (candidate !== undefined && candidate.connectedAccount !== null) {
        return {
          connectedAccountId: candidate.connectedAccount.id,
          evidence: {
            _tag: "IntegrationConnectionConnected" as const,
            connectionBinding: yield* connectionBindingFor(candidate.connectedAccount.id),
            toolkit: input.toolkit,
            userId: input.userId,
          },
          session,
        };
      }
      if (candidates.every(({ connectedAccount }) => connectedAccount === null)) {
        return connectionInspection(input, "IntegrationConnectionMissing", session);
      }
      return connectionInspection(input, "IntegrationConnectionStale", session);
    },
  );

  const inspectConnection = Effect.fn("Integrations.inspectConnection")(function* (input: {
    readonly toolkit: string;
    readonly userId: UserId;
  }) {
    if (!isSupportedToolkit(input.toolkit)) {
      return yield* unsupportedToolkit(input.toolkit, "CONNECTION_EVIDENCE");
    }
    const { session } = yield* resolveProviderSession(input.userId);
    return yield* inspectConnectionInSession(input, session);
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

  const execute = Effect.fn("Integrations.execute")(function* <E, F = never>(
    input: ExecuteIntegrationInput<E, F>,
  ) {
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
        providerConstraintsFor(manifest, decoded.success),
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
        const retained = yield* ports.readAction(actionId);
        if (retained?._tag === "Applied" && retained.digest === digest) {
          yield* finalizeEffect(input.finalizeEffect, {
            _tag: "Applied",
            result: retained.result,
          });
          return retained.result;
        }
        if (retained !== null && retained.digest !== digest) {
          return yield* new IntegrationActionConflict({
            actionId,
            message: "The Action identity is already bound to different integration facts",
          });
        }
        if (retained?._tag === "NotApplied") {
          yield* finalizeEffect(input.finalizeEffect, {
            _tag: "NotApplied",
            providerLogId: retained.providerLogId,
          });
          return yield* new IntegrationActionNotApplied({
            actionId,
            message: "The integration Action is finally not applied",
            providerLogId: retained.providerLogId,
          });
        }
        if (
          retained?._tag === "Pending" ||
          retained?._tag === "Ambiguous" ||
          retained?._tag === "TerminalAmbiguous"
        ) {
          return yield* new IntegrationActionAmbiguous({
            actionId,
            message: "The integration Action has an unresolved provider outcome",
          });
        }
        const actionSession = yield* ports.createSession(
          input.userId,
          directIntegrationProviderConfig,
        );
        const inspectedConnection = yield* inspectConnectionInSession(
          { toolkit: manifest.toolkit, userId: input.userId },
          actionSession.session,
        );
        if (!("connectedAccountId" in inspectedConnection)) {
          return yield* new IntegrationConnectionUnavailable({
            message: "The required Integration Connection is not current and unambiguous",
            toolkit: manifest.toolkit,
            userId: input.userId,
          });
        }
        yield* input.authorize;
        const connection = {
          connectedAccountId: inspectedConnection.connectedAccountId,
          session: actionSession.session,
        };
        const correlation = {
          connectedAccountId: connection.connectedAccountId,
          providerRequestId: crypto.randomUUID(),
          providerSessionId: actionSession.providerSessionId,
          providerTool: manifest.providerTool,
          startedAt: yield* Clock.currentTimeMillis,
        } satisfies ProviderAttemptCorrelation;
        yield* ports.retainAction(actionId, { _tag: "Pending", correlation, digest });
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
            yield* ports.retainAction(actionId, {
              _tag: "NotApplied",
              digest,
              providerLogId: null,
            });
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
            Effect.tapError(() =>
              ports.retainAction(actionId, {
                _tag: "NotApplied",
                digest,
                providerLogId: null,
              }),
            ),
          );
          const stageAttempt = yield* Effect.exit(connection.session.stageFile(artifact));
          if (Predicate.isTagged(stageAttempt, "Failure")) {
            yield* ports.retainAction(actionId, { _tag: "Ambiguous", correlation, digest });
            return yield* new IntegrationActionAmbiguous({
              actionId,
              message: "The integration file staging outcome is unknown",
            });
          }
          providerInput = {
            file_to_upload: stageAttempt.value,
            folder_to_upload_to: request.targetFolderId,
          };
        }
        const attempted = yield* Effect.exit(
          connection.session.execute(
            manifest.providerTool,
            providerInput,
            connection.connectedAccountId,
            undefined,
            correlation,
          ),
        );
        if (Predicate.isTagged(attempted, "Failure")) {
          yield* ports.retainAction(actionId, { _tag: "Ambiguous", correlation, digest });
          return yield* new IntegrationActionAmbiguous({
            actionId,
            message: "The integration provider outcome is unknown",
          });
        }
        if (attempted.value.error !== null) {
          const settled = yield* ports.settleAction(actionId, correlation.providerRequestId, {
            _tag: "NotApplied",
            digest,
            providerLogId: attempted.value.logId,
          });
          if (settled._tag === "Applied") {
            yield* finalizeEffect(input.finalizeEffect, {
              _tag: "Applied",
              result: settled.result,
            });
            return settled.result;
          }
          if (settled._tag !== "NotApplied") {
            return yield* new IntegrationActionAmbiguous({
              actionId,
              message: "The integration provider evidence belongs to another Action",
            });
          }
          yield* finalizeEffect(input.finalizeEffect, {
            _tag: "NotApplied",
            providerLogId: settled.providerLogId,
          });
          return yield* providerRejection(manifest, attempted.value);
        }
        const result = yield* normalizeEffect(manifest, attempted.value, decoded.success).pipe(
          Effect.tapError(() =>
            ports.retainAction(actionId, { _tag: "Ambiguous", correlation, digest }),
          ),
        );
        const settled = yield* ports.settleAction(actionId, correlation.providerRequestId, {
          _tag: "Applied",
          digest,
          providerRequestId: correlation.providerRequestId,
          result,
        });
        if (settled._tag !== "Applied") {
          return yield* new IntegrationActionAmbiguous({
            actionId,
            message: "The integration provider evidence belongs to another Action",
          });
        }
        yield* finalizeEffect(input.finalizeEffect, {
          _tag: "Applied",
          result: settled.result,
        });
        return settled.result;
      }),
    );
  });

  const terminalizeAmbiguous = Effect.fn("Integrations.terminalizeAmbiguous")(function* <F>(
    actionId: ActionId,
    correlation: ProviderAttemptCorrelation,
    digest: string,
    finalizer: ExecuteIntegrationInput<never, F>["finalizeEffect"],
  ) {
    yield* ports.retainAction(actionId, {
      _tag: "TerminalAmbiguous",
      correlation,
      digest,
    });
    yield* finalizeEffect(finalizer, { _tag: "Ambiguous" });
    return { _tag: "TerminalAmbiguous" as const };
  });

  const inspectAction = Effect.fn("Integrations.inspectAction")(function* <F = never>(
    input: InspectIntegrationActionInput<F>,
  ) {
    const resolved = resolveManifest(input.identity);
    if (Result.isFailure(resolved)) return yield* resolved.failure;
    const manifest = resolved.success;
    if (manifest.operationKind !== "effect") {
      return yield* new IntegrationActionConflict({
        actionId: input.actionId,
        message: "Only an integration effect has a durable Action identity",
      });
    }
    const decoded = manifest.decodeInput(input.input);
    if (Result.isFailure(decoded)) return yield* decoded.failure;
    const providerInput = providerInputFor(manifest, decoded.success);
    const digest = yield* actionDigest(manifest, decoded.success);
    return yield* actionLock.withPermits(1)(
      Effect.gen(function* () {
        let retained = yield* ports.readAction(input.actionId);
        if (retained === null) return { _tag: "NotStarted" as const };
        if (retained.digest !== digest) {
          return yield* new IntegrationActionConflict({
            actionId: input.actionId,
            message: "The Action identity is already bound to different integration facts",
          });
        }
        if (retained._tag === "Applied") {
          yield* finalizeEffect(input.finalizeEffect, {
            _tag: "Applied",
            result: retained.result,
          });
          return { _tag: "Applied" as const, result: retained.result };
        }
        if (retained._tag === "NotApplied") {
          yield* finalizeEffect(input.finalizeEffect, {
            _tag: "NotApplied",
            providerLogId: retained.providerLogId,
          });
          return { _tag: "NotApplied" as const, providerLogId: retained.providerLogId };
        }
        if (retained._tag === "TerminalAmbiguous") {
          yield* finalizeEffect(input.finalizeEffect, { _tag: "Ambiguous" });
          return { _tag: "TerminalAmbiguous" as const };
        }
        if (retained._tag === "Pending") {
          const now = yield* Clock.currentTimeMillis;
          if (
            retained.correlation !== null &&
            now - retained.correlation.startedAt < initialActionReconciliationDelayMilliseconds
          ) {
            return { _tag: "Pending" as const };
          }
          retained = { _tag: "Ambiguous", correlation: retained.correlation, digest };
          yield* ports.retainAction(input.actionId, retained);
        }
        if (retained.correlation === null) {
          return { _tag: "TerminalAmbiguous" as const };
        }
        const now = yield* Clock.currentTimeMillis;
        const retryAfterMilliseconds =
          retained.correlation.startedAt + providerEvidenceHorizonMilliseconds - now;
        if (retained.correlation.providerSessionId === null) {
          if (retryAfterMilliseconds > 0) {
            return { _tag: "Ambiguous" as const, retryAfterMilliseconds };
          }
          return yield* terminalizeAmbiguous(
            input.actionId,
            retained.correlation,
            digest,
            input.finalizeEffect,
          );
        }
        if (retained.correlation.providerRequestId === null) {
          if (retryAfterMilliseconds > 0) {
            return { _tag: "Ambiguous" as const, retryAfterMilliseconds };
          }
          return yield* terminalizeAmbiguous(
            input.actionId,
            retained.correlation,
            digest,
            input.finalizeEffect,
          );
        }
        const session = yield* ports
          .useSession(input.userId, retained.correlation.providerSessionId)
          .pipe(
            Effect.map(Option.some),
            Effect.catchTag("IntegrationProviderUnavailable", (failure) =>
              retryAfterMilliseconds > 0 && failure.reason === "unavailable"
                ? Effect.fail(failure)
                : Effect.succeed(Option.none()),
            ),
          );
        if (Option.isNone(session)) {
          if (retryAfterMilliseconds > 0) {
            return { _tag: "Ambiguous" as const, retryAfterMilliseconds };
          }
          return yield* terminalizeAmbiguous(
            input.actionId,
            retained.correlation,
            digest,
            input.finalizeEffect,
          );
        }
        if (session.value.inspectExecution === undefined) {
          if (retryAfterMilliseconds > 0) {
            return { _tag: "Ambiguous" as const, retryAfterMilliseconds };
          }
          return yield* terminalizeAmbiguous(
            input.actionId,
            retained.correlation,
            digest,
            input.finalizeEffect,
          );
        }
        const evidence = yield* session.value
          .inspectExecution(retained.correlation, providerInput)
          .pipe(
            Effect.map(Option.some),
            Effect.catchTag("IntegrationProviderUnavailable", (failure) =>
              retryAfterMilliseconds > 0 && failure.reason === "unavailable"
                ? Effect.fail(failure)
                : Effect.succeed(Option.none()),
            ),
          );
        if (Option.isNone(evidence)) {
          if (retryAfterMilliseconds > 0) {
            return { _tag: "Ambiguous" as const, retryAfterMilliseconds };
          }
          return yield* terminalizeAmbiguous(
            input.actionId,
            retained.correlation,
            digest,
            input.finalizeEffect,
          );
        }
        if (evidence.value._tag === "Unknown") {
          if (retryAfterMilliseconds > 0) {
            return { _tag: "Ambiguous" as const, retryAfterMilliseconds };
          }
          return yield* terminalizeAmbiguous(
            input.actionId,
            retained.correlation,
            digest,
            input.finalizeEffect,
          );
        }
        if (evidence.value._tag === "NotApplied") {
          const settled = yield* ports.settleAction(
            input.actionId,
            retained.correlation.providerRequestId,
            {
              _tag: "NotApplied",
              digest,
              providerLogId: evidence.value.providerLogId,
            },
          );
          if (settled._tag === "Applied") {
            yield* finalizeEffect(input.finalizeEffect, {
              _tag: "Applied",
              result: settled.result,
            });
            return { _tag: "Applied" as const, result: settled.result };
          }
          if (settled._tag !== "NotApplied") {
            return { _tag: "Ambiguous" as const, retryAfterMilliseconds: 0 };
          }
          yield* finalizeEffect(input.finalizeEffect, {
            _tag: "NotApplied",
            providerLogId: settled.providerLogId,
          });
          return { _tag: "NotApplied" as const, providerLogId: evidence.value.providerLogId };
        }
        const normalized = yield* Effect.result(
          normalizeEffect(manifest, evidence.value.execution, decoded.success),
        );
        if (Result.isFailure(normalized)) {
          if (normalized.failure.code !== "resultInvalid") {
            return yield* normalized.failure;
          }
          if (retryAfterMilliseconds <= 0) {
            return yield* terminalizeAmbiguous(
              input.actionId,
              retained.correlation,
              digest,
              input.finalizeEffect,
            );
          }
          return {
            _tag: "Ambiguous" as const,
            retryAfterMilliseconds,
          };
        }
        const result = normalized.success;
        const settled = yield* ports.settleAction(
          input.actionId,
          retained.correlation.providerRequestId,
          {
            _tag: "Applied",
            digest,
            providerRequestId: retained.correlation.providerRequestId,
            result,
          },
        );
        if (settled._tag === "NotApplied") {
          return { _tag: "NotApplied" as const, providerLogId: settled.providerLogId };
        }
        if (settled._tag !== "Applied") {
          return { _tag: "Ambiguous" as const, retryAfterMilliseconds: 0 };
        }
        yield* finalizeEffect(input.finalizeEffect, {
          _tag: "Applied",
          result: settled.result,
        });
        return { _tag: "Applied" as const, result: settled.result };
      }),
    );
  });

  const readActionStatus = Effect.fn("Integrations.readActionStatus")(function* (
    input: Omit<InspectIntegrationActionInput, "finalizeEffect" | "userId">,
  ) {
    const resolved = resolveManifest(input.identity);
    if (Result.isFailure(resolved)) return yield* resolved.failure;
    const manifest = resolved.success;
    if (manifest.operationKind !== "effect") {
      return yield* new IntegrationActionConflict({
        actionId: input.actionId,
        message: "Only an integration effect has a durable Action identity",
      });
    }
    const decoded = manifest.decodeInput(input.input);
    if (Result.isFailure(decoded)) return yield* decoded.failure;
    const digest = yield* actionDigest(manifest, decoded.success);
    return yield* actionLock.withPermits(1)(
      Effect.gen(function* () {
        const retained = yield* ports.readAction(input.actionId);
        if (retained === null) return { _tag: "NotStarted" as const };
        if (retained.digest !== digest) {
          return yield* new IntegrationActionConflict({
            actionId: input.actionId,
            message: "The Action identity is already bound to different integration facts",
          });
        }
        if (retained._tag === "Applied") {
          return { _tag: "Applied" as const, result: retained.result };
        }
        if (retained._tag === "NotApplied") {
          return { _tag: "NotApplied" as const, providerLogId: retained.providerLogId };
        }
        if (retained._tag === "TerminalAmbiguous") {
          return { _tag: "TerminalAmbiguous" as const };
        }
        if (retained._tag === "Pending") return { _tag: "Pending" as const };
        const now = yield* Clock.currentTimeMillis;
        const retryAfterMilliseconds =
          retained.correlation === null
            ? 0
            : Math.max(
                0,
                retained.correlation.startedAt + providerEvidenceHorizonMilliseconds - now,
              );
        return { _tag: "Ambiguous" as const, retryAfterMilliseconds };
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
      if (!isSupportedToolkit(input.toolkit)) {
        return yield* unsupportedToolkit(input.toolkit, "DISCONNECT");
      }
      const { session } = yield* resolveProviderSession(input.userId);
      const accounts = (yield* session.inspectToolkits([input.toolkit])).filter(
        ({ connectedAccount, slug }) => slug === input.toolkit && connectedAccount !== null,
      );
      if (accounts.length === 0) {
        return yield* new IntegrationConnectionUnavailable({
          message: "The required Integration Connection is not current and unambiguous",
          toolkit: input.toolkit,
          userId: input.userId,
        });
      }
      yield* Effect.forEach(
        accounts,
        ({ connectedAccount }) =>
          connectedAccount === null ? Effect.void : session.disconnect(connectedAccount.id),
        { concurrency: 1, discard: true },
      );
      return { _tag: "IntegrationConnectionRevoked" as const, toolkit: input.toolkit };
    }),
    execute,
    inspectAction,
    readActionStatus,
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

const finalizeEffect = <F>(
  finalize: ExecuteIntegrationInput<never, F>["finalizeEffect"],
  outcome: IntegrationEffectFinalOutcome,
) => (finalize === undefined ? Effect.void : finalize(outcome));

const normalizeRead = (
  manifest: ResolvedIntegrationManifestOperation,
  execution: ProviderExecutionResult,
  input: Schema.Json,
) =>
  Effect.gen(function* () {
    const providerLogId = yield* validateProviderResult(manifest, execution);
    const providerLogIds = [...(execution.supportingLogIds ?? []), providerLogId];
    if (
      providerLogIds.length !== manifest.hardBounds.providerExecutions ||
      providerLogIds.some((logId) => logId.trim().length === 0 || logId.length > 500)
    ) {
      return yield* invalidProviderResult(manifest);
    }
    const candidates = yield* readCandidates(manifest, execution.data);
    const records: Array<Record<string, boolean | number | string | null>> = [];
    let truncated = candidates.length > manifest.hardBounds.maximumRecords;
    for (const candidate of candidates.slice(0, manifest.hardBounds.maximumRecords)) {
      const projected = yield* projectSafeRecord(manifest, candidate);
      yield* validateRequestedDriveFile(manifest, projected, input);
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
      evidence: { providerLogIds },
      manifestVersion: manifest.manifestVersion,
      operation: manifest.operation,
      records,
      responseBytes,
      toolkit: manifest.toolkit,
      truncated,
    };
  });

const validateRequestedDriveFile = (
  manifest: ResolvedIntegrationManifestOperation,
  record: Record<string, boolean | number | string | null>,
  input: Schema.Json,
) => {
  if (manifest.operation === "DRIVE_GET_METADATA") {
    const expected = Schema.decodeUnknownSync(DriveGetMetadataInput)(input).fileId;
    return record.id === expected ? Effect.void : Effect.fail(invalidProviderResult(manifest));
  }
  if (manifest.operation === "DRIVE_READ_FILE") {
    const expected = Schema.decodeUnknownSync(DriveReadFileInput)(input).fileId;
    return record.fileId === expected ? Effect.void : Effect.fail(invalidProviderResult(manifest));
  }
  return Effect.void;
};

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
  input: Schema.Json,
) =>
  Effect.gen(function* () {
    const providerLogId = yield* validateProviderResult(manifest, execution);
    const providerResourceId = yield* effectResourceId(manifest, execution.data, input);
    return {
      _tag: "IntegrationEffectCompleted" as const,
      evidence: { providerLogId, providerResourceId },
      manifestVersion: manifest.manifestVersion,
      mutations: 1 as const,
      operation: manifest.operation,
      toolkit: manifest.toolkit,
    };
  });

const ProviderResource = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});

const effectResourceId = (
  manifest: ResolvedIntegrationManifestOperation,
  data: Schema.JsonObject,
  input: Schema.Json,
) => {
  if (manifest.operation === "CALENDAR_DELETE_EVENT") {
    return Effect.succeed(Schema.decodeUnknownSync(CalendarDeleteEventInput)(input).eventId);
  }
  const decoded = Schema.decodeUnknownOption(ProviderResource)(data);
  if (Option.isNone(decoded)) return Effect.fail(invalidProviderResult(manifest));
  if (manifest.operation === "CALENDAR_UPDATE_EVENT") {
    const expected = Schema.decodeUnknownSync(CalendarUpdateEventInput)(input).eventId;
    if (decoded.value.id !== expected) return Effect.fail(invalidProviderResult(manifest));
  }
  return Effect.succeed(decoded.value.id);
};

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
      return sha256Hex(encoded);
    },
    catch: (cause) =>
      new IntegrationPersistenceUnavailable({
        cause,
        message: "The Action identity digest could not be computed",
        operation: "digestAction",
      }),
  });

const connectionBindingFor = (
  connectedAccountId: string,
): Effect.Effect<IntegrationConnectionBinding, IntegrationPersistenceUnavailable> =>
  Effect.tryPromise({
    try: () =>
      sha256Hex(
        new TextEncoder().encode(`osfo-integration-connection-v1:${connectedAccountId}`),
      ).then((digest) => IntegrationConnectionBinding.make(digest)),
    catch: (cause) =>
      new IntegrationPersistenceUnavailable({
        cause,
        message: "The private Integration Connection binding could not be computed",
        operation: "bindConnection",
      }),
  });

const sha256Hex = (value: Uint8Array): Promise<string> =>
  crypto.subtle
    .digest("SHA-256", new Uint8Array(value))
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );

export * as Integrations from "./integrations";
