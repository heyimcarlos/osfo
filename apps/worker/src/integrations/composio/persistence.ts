import { Effect, Schema } from "effect";

import { ManifestVersion, UserId } from "../../domain";
import type { ActionId } from "../../domain/action-execution";
import {
  IntegrationPersistenceUnavailable,
  type IntegrationPersistence,
  type PersistedIntegrationAction,
} from "../../services/integrations";

/* oxlint-disable effecttsgo/async-function, eslint/no-underscore-dangle -- Durable Object transaction callbacks are Promise-based host boundaries; persisted outcomes use the canonical _tag discriminator. */

const persistenceVersion = "composio-direct-v1";
const boundedProviderIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const actionDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

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

const PersistedAction = Schema.Union([
  Schema.TaggedStruct("Pending", { digest: actionDigest }),
  Schema.TaggedStruct("Ambiguous", { digest: actionDigest }),
  Schema.TaggedStruct("NotApplied", { digest: actionDigest }),
  Schema.TaggedStruct("Applied", { digest: actionDigest, result: PersistedEffectResult }),
]);

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

const persistenceFailure = (operation: string) =>
  new IntegrationPersistenceUnavailable({
    cause: operation,
    message: "Integration state is unavailable",
    operation,
  });

export * as ComposioPersistence from "./persistence";
