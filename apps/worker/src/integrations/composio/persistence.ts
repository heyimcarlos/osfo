import { Effect, Schema } from "effect";

import { ManifestVersion, UserId } from "../../domain";
import { ActionId } from "../../domain/action-execution";
import {
  IntegrationPersistenceUnavailable,
  type IntegrationPersistence,
  type PersistedIntegrationAction,
  type PersistedIntegrationActionSettlement,
} from "../../services/integrations";

/* oxlint-disable effecttsgo/async-function, eslint/no-underscore-dangle -- Durable Object transaction callbacks are Promise-based host boundaries; persisted outcomes use the canonical _tag discriminator. */

const persistenceVersion = "composio-direct-v1";
const boundedProviderIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const actionDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const ProviderAttemptCorrelation = Schema.Struct({
  connectedAccountId: boundedProviderIdentity,
  providerRequestId: Schema.optionalKey(Schema.NullOr(boundedProviderIdentity)),
  providerSessionId: Schema.optionalKey(Schema.NullOr(boundedProviderIdentity)),
  providerTool: boundedProviderIdentity,
  startedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const PersistedEffectResult = Schema.TaggedStruct("IntegrationEffectCompleted", {
  evidence: Schema.Struct({
    providerLogId: boundedProviderIdentity,
    // Legacy pre-pack effects retain only the execution identity.
    providerResourceId: Schema.optionalKey(boundedProviderIdentity),
  }),
  manifestVersion: ManifestVersion,
  mutations: Schema.Literal(1),
  operation: Schema.Literals([
    // Retain the two pre-pack operation names so an old Action remains readable.
    "GMAIL_CREATE_DRAFT",
    "CALENDAR_CREATE_PRIVATE",
    "GMAIL_SEND_EMAIL",
    "CALENDAR_CREATE_EVENT",
    "CALENDAR_UPDATE_EVENT",
    "CALENDAR_DELETE_EVENT",
    "DRIVE_DELIVER_ARTIFACT",
  ]),
  toolkit: Schema.Literals(["gmail", "googlecalendar", "googledrive"]),
});

const PersistedNotApplied = Schema.TaggedStruct("NotApplied", {
  digest: actionDigest,
  providerLogId: Schema.optionalKey(Schema.NullOr(boundedProviderIdentity)),
});

const PersistedApplied = Schema.TaggedStruct("Applied", {
  digest: actionDigest,
  result: PersistedEffectResult,
});

const PersistedAction = Schema.Union([
  Schema.TaggedStruct("Pending", {
    correlation: Schema.optionalKey(Schema.NullOr(ProviderAttemptCorrelation)),
    digest: actionDigest,
  }),
  Schema.TaggedStruct("Ambiguous", {
    correlation: Schema.optionalKey(Schema.NullOr(ProviderAttemptCorrelation)),
    digest: actionDigest,
  }),
  PersistedNotApplied,
  PersistedApplied,
]);

const PersistedActionSettlement = Schema.Union([PersistedNotApplied, PersistedApplied]);

const ProviderExecutionClaim = Schema.Struct({
  actionId: ActionId,
  version: Schema.Literal(persistenceVersion),
});

const SessionMapping = Schema.Struct({
  providerSessionId: boundedProviderIdentity,
  userId: UserId,
  version: Schema.Literal(persistenceVersion),
});

/** Persist private provider mappings and safe Action state in the owning User's Agent storage. */
export const make = (storage: DurableObjectStorage): IntegrationPersistence => ({
  readAction: (actionId) =>
    Effect.tryPromise({
      try: () => storage.get(actionKey(actionId)),
      catch: () => persistenceFailure("readAction"),
    }).pipe(
      Effect.flatMap((value) =>
        value === undefined
          ? Effect.succeed(null)
          : Schema.decodeUnknownEffect(PersistedAction)(value, {
              onExcessProperty: "error",
            }).pipe(
              Effect.map(normalizePersistedAction),
              Effect.mapError(() => persistenceFailure("readAction")),
            ),
      ),
    ),
  readSession: (userId) =>
    Effect.tryPromise({
      try: () => storage.get(sessionKey(userId)),
      catch: () => persistenceFailure("readSession"),
    }).pipe(
      Effect.flatMap((value) =>
        value === undefined
          ? Effect.succeed(null)
          : Schema.decodeUnknownEffect(SessionMapping)(value, {
              onExcessProperty: "error",
            }).pipe(Effect.mapError(() => persistenceFailure("readSession"))),
      ),
      Effect.flatMap((mapping) =>
        mapping === null
          ? Effect.succeed(null)
          : mapping.userId === userId
            ? Effect.succeed(mapping.providerSessionId)
            : Effect.fail(persistenceFailure("readSession")),
      ),
    ),
  replaceSession: (userId, expectedProviderSessionId, replacementProviderSessionId) =>
    Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => {
          const key = sessionKey(userId);
          const existing = Schema.decodeUnknownSync(SessionMapping)(await transaction.get(key), {
            onExcessProperty: "error",
          });
          if (existing.providerSessionId !== expectedProviderSessionId) {
            return existing.providerSessionId;
          }
          await transaction.put(
            key,
            SessionMapping.make({
              providerSessionId: replacementProviderSessionId,
              userId,
              version: persistenceVersion,
            }),
          );
          return replacementProviderSessionId;
        }),
      catch: () => persistenceFailure("replaceSession"),
    }),
  retainAction: (actionId, value) =>
    Schema.decodeUnknownEffect(PersistedAction)(value, { onExcessProperty: "error" }).pipe(
      Effect.map(normalizePersistedAction),
      Effect.flatMap((validated) =>
        Effect.tryPromise({
          try: () => storage.put(actionKey(actionId), validated),
          catch: () => persistenceFailure("retainAction"),
        }),
      ),
      Effect.mapError(() => persistenceFailure("retainAction")),
    ),
  settleAction: (actionId, providerRequestId, value) =>
    Schema.decodeUnknownEffect(PersistedActionSettlement)(value, {
      onExcessProperty: "error",
    }).pipe(
      Effect.map(normalizePersistedAction),
      Effect.flatMap((validated) =>
        validated._tag === "Applied" || validated._tag === "NotApplied"
          ? Effect.tryPromise({
              try: () => settleAction(storage, actionId, providerRequestId, validated),
              catch: () => persistenceFailure("settleAction"),
            })
          : Effect.fail(persistenceFailure("settleAction")),
      ),
      Effect.mapError(() => persistenceFailure("settleAction")),
    ),
  retainSession: (userId, providerSessionId) =>
    Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => {
          const key = sessionKey(userId);
          const existing = await transaction.get(key);
          if (existing !== undefined) {
            return Schema.decodeUnknownSync(SessionMapping)(existing, {
              onExcessProperty: "error",
            }).providerSessionId;
          }
          const mapping = SessionMapping.make({
            providerSessionId,
            userId,
            version: persistenceVersion,
          });
          await transaction.put(key, mapping);
          return providerSessionId;
        }),
      catch: () => persistenceFailure("retainSession"),
    }),
});

const normalizePersistedAction = (
  value: typeof PersistedAction.Type,
): PersistedIntegrationAction => {
  if (value._tag === "Pending" || value._tag === "Ambiguous") {
    return {
      ...value,
      correlation:
        value.correlation === undefined || value.correlation === null
          ? null
          : {
              ...value.correlation,
              providerRequestId: value.correlation.providerRequestId ?? null,
              providerSessionId: value.correlation.providerSessionId ?? null,
            },
    };
  }
  if (value._tag === "NotApplied") {
    return { ...value, providerLogId: value.providerLogId ?? null };
  }
  if (value._tag !== "Applied") return value;
  return {
    ...value,
    result: {
      ...value.result,
      evidence: {
        providerLogId: value.result.evidence.providerLogId,
        providerResourceId:
          value.result.evidence.providerResourceId ?? value.result.evidence.providerLogId,
      },
    },
  };
};

const sessionKey = (userId: UserId): string => `integration:session:${userId}`;
const actionKey = (actionId: ActionId): string => `integration:action:${actionId}`;
const providerExecutionClaimKey = (providerLogId: string): string =>
  `integration:provider-execution:${providerLogId}`;

const settleAction = (
  storage: DurableObjectStorage,
  actionId: ActionId,
  providerRequestId: string,
  value: PersistedIntegrationActionSettlement,
): Promise<PersistedIntegrationAction> =>
  storage.transaction(async (transaction) => {
    const retainedValue = await transaction.get(actionKey(actionId));
    if (retainedValue === undefined) throw new Error("The Action attempt is not retained");
    const retained = normalizePersistedAction(
      Schema.decodeUnknownSync(PersistedAction)(retainedValue, { onExcessProperty: "error" }),
    );
    if (retained.digest !== value.digest) throw new Error("The Action digest changed");
    if (retained._tag !== "Pending" && retained._tag !== "Ambiguous") return retained;
    if (retained.correlation?.providerRequestId !== providerRequestId) return retained;
    const providerLogId =
      value._tag === "Applied" ? value.result.evidence.providerLogId : value.providerLogId;
    if (providerLogId !== null) {
      const claimKey = providerExecutionClaimKey(providerLogId);
      const claimedValue = await transaction.get(claimKey);
      if (claimedValue !== undefined) {
        const claimed = Schema.decodeUnknownSync(ProviderExecutionClaim)(claimedValue, {
          onExcessProperty: "error",
        });
        if (claimed.actionId !== actionId) {
          const ambiguous =
            retained._tag === "Pending" ? { ...retained, _tag: "Ambiguous" as const } : retained;
          if (retained._tag === "Pending") {
            await transaction.put(actionKey(actionId), ambiguous);
          }
          return ambiguous;
        }
      } else {
        await transaction.put(
          claimKey,
          ProviderExecutionClaim.make({ actionId, version: persistenceVersion }),
        );
      }
    }
    await transaction.put(actionKey(actionId), value);
    return value;
  });

const persistenceFailure = (operation: string) =>
  new IntegrationPersistenceUnavailable({
    cause: operation,
    message: "Integration state is unavailable",
    operation,
  });

export * as ComposioPersistence from "./persistence";
