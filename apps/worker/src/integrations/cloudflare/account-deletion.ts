import { Array, Effect, Schema } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import { AccountDeletion } from "../../services/account-deletion";
import {
  attemptKeyForContentKey,
  documentAttemptPrefix,
  documentContentPrefix,
} from "./document-storage-keys";

const ArtifactMetadata = Schema.fromJsonString(Schema.Struct({ userId: UserId }));
const AttemptMetadata = Schema.fromJsonString(
  Schema.Struct({
    cost: Schema.Struct({ allowancePeriodId: AllowancePeriodId }),
    userId: Schema.optionalKey(UserId),
  }),
);

/** Build idempotent R2 erasure for User files and generated-document evidence. */
export const make = (
  files: R2Bucket,
  artifacts: R2Bucket,
  readAllowancePeriodIds: (
    userId: UserId,
  ) => Effect.Effect<ReadonlySet<AllowancePeriodId>, AccountDeletion.AccountDeletionUnavailable>,
): AccountDeletion.PortInterface["objects"] => ({
  remove: (userId, authorizeDelete) =>
    readAllowancePeriodIds(userId).pipe(
      Effect.flatMap((allowancePeriodIds) =>
        deletePrefix(files, `users/${encodeURIComponent(userId)}/`, authorizeDelete).pipe(
          Effect.andThen(deleteArtifacts(artifacts, userId, allowancePeriodIds, authorizeDelete)),
        ),
      ),
    ),
});

const deletePrefix: (
  bucket: R2Bucket,
  prefix: string,
  authorizeDelete: Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable>,
  cursor?: string,
) => Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable> = Effect.fn(
  "AccountDeletionCloudflare.deletePrefix",
)(function* (
  bucket: R2Bucket,
  prefix: string,
  authorizeDelete: Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable>,
  cursor?: string,
) {
  const page = yield* attempt("removeObjects", () =>
    bucket.list(cursor === undefined ? { prefix } : { cursor, prefix }),
  );
  if (page.objects.length > 0) {
    yield* authorizeDelete;
    yield* attempt("removeObjects", () => bucket.delete(page.objects.map(({ key }) => key)));
  }
  if (page.truncated) yield* deletePrefix(bucket, prefix, authorizeDelete, page.cursor);
});

const deleteArtifacts: (
  bucket: R2Bucket,
  userId: UserId,
  allowancePeriodIds: ReadonlySet<AllowancePeriodId>,
  authorizeDelete: Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable>,
) => Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable> = Effect.fn(
  "AccountDeletionCloudflare.deleteArtifacts",
)(function* (
  bucket: R2Bucket,
  userId: UserId,
  allowancePeriodIds: ReadonlySet<AllowancePeriodId>,
  authorizeDelete: Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable>,
) {
  const targetArtifacts = yield* discoverArtifacts(bucket, userId);
  const pairedAttemptKeys = new Set(targetArtifacts.map(({ attemptKey }) => attemptKey));
  const targetAttemptKeys = yield* discoverAttemptEvidence(
    bucket,
    userId,
    allowancePeriodIds,
    pairedAttemptKeys,
  );
  const contentKeys = yield* Effect.forEach(targetArtifacts, ({ contentKey }) =>
    verifyConcreteObject(bucket, contentKey, (object) =>
      decodeArtifactMetadata(object).pipe(
        Effect.flatMap((metadata) =>
          metadata.userId === userId
            ? Effect.void
            : Effect.fail(
                ambiguousObjectOwnership(contentKey, "artifact ownership changed before deletion"),
              ),
        ),
      ),
    ),
  );
  const attemptKeys = yield* Effect.forEach(targetAttemptKeys, (key) =>
    verifyConcreteObject(bucket, key, (object) =>
      selectAttemptEvidence(object, userId, allowancePeriodIds, pairedAttemptKeys).pipe(
        Effect.flatMap((owned) =>
          owned
            ? Effect.void
            : Effect.fail(
                ambiguousObjectOwnership(key, "attempt ownership changed before deletion"),
              ),
        ),
      ),
    ),
  );
  const keys = [...contentKeys.flat(), ...attemptKeys.flat()];
  yield* Effect.forEach(
    Array.chunksOf(keys, 1_000),
    (keyBatch) =>
      authorizeDelete.pipe(Effect.andThen(attempt("removeObjects", () => bucket.delete(keyBatch)))),
    { discard: true },
  );
});

const discoverArtifacts: (
  bucket: R2Bucket,
  userId: UserId,
  cursor?: string,
) => Effect.Effect<
  ReadonlyArray<{ readonly attemptKey: string; readonly contentKey: string }>,
  AccountDeletion.AccountDeletionUnavailable
> = Effect.fn("AccountDeletionCloudflare.discoverArtifacts")(function* (
  bucket: R2Bucket,
  userId: UserId,
  cursor?: string,
) {
  const page = yield* attempt("removeObjects", () =>
    bucket.list(
      cursor === undefined
        ? { include: ["customMetadata"], prefix: documentContentPrefix }
        : { cursor, include: ["customMetadata"], prefix: documentContentPrefix },
    ),
  );
  const targetGroups = yield* Effect.forEach(page.objects, (object) =>
    decodeArtifactMetadata(object).pipe(
      Effect.flatMap((metadata) => {
        if (metadata.userId !== userId) return Effect.succeed([]);
        const attemptKey = attemptKeyForContentKey(object.key);
        if (attemptKey !== undefined) {
          return Effect.succeed([{ attemptKey, contentKey: object.key }]);
        }
        return Effect.fail(ambiguousObjectOwnership(object.key, "malformed artifact key"));
      }),
    ),
  );
  const targets = targetGroups.flat();
  if (page.truncated) {
    return [...targets, ...(yield* discoverArtifacts(bucket, userId, page.cursor))];
  }
  return targets;
});

const discoverAttemptEvidence: (
  bucket: R2Bucket,
  userId: UserId,
  allowancePeriodIds: ReadonlySet<AllowancePeriodId>,
  pairedAttemptKeys: ReadonlySet<string>,
  cursor?: string,
) => Effect.Effect<ReadonlyArray<string>, AccountDeletion.AccountDeletionUnavailable> = Effect.fn(
  "AccountDeletionCloudflare.discoverAttemptEvidence",
)(function* (
  bucket: R2Bucket,
  userId: UserId,
  allowancePeriodIds: ReadonlySet<AllowancePeriodId>,
  pairedAttemptKeys: ReadonlySet<string>,
  cursor?: string,
) {
  const page = yield* attempt("removeObjects", () =>
    bucket.list(
      cursor === undefined
        ? { include: ["customMetadata"], prefix: documentAttemptPrefix }
        : { cursor, include: ["customMetadata"], prefix: documentAttemptPrefix },
    ),
  );
  const keyGroups = yield* Effect.forEach(page.objects, (object) =>
    selectAttemptEvidence(object, userId, allowancePeriodIds, pairedAttemptKeys).pipe(
      Effect.map((owned) => (owned ? [object.key] : [])),
    ),
  );
  const keys = keyGroups.flat();
  if (page.truncated) {
    return [
      ...keys,
      ...(yield* discoverAttemptEvidence(
        bucket,
        userId,
        allowancePeriodIds,
        pairedAttemptKeys,
        page.cursor,
      )),
    ];
  }
  return keys;
});

const selectAttemptEvidence = (
  object: R2Object,
  userId: UserId,
  allowancePeriodIds: ReadonlySet<AllowancePeriodId>,
  pairedAttemptKeys: ReadonlySet<string>,
) =>
  decodeAttemptMetadata(object).pipe(
    Effect.flatMap((metadata) => {
      if (metadata.userId === userId) return Effect.succeed(true);
      const matchesTargetArtifact = pairedAttemptKeys.has(object.key);
      const matchesTargetAllowance = allowancePeriodIds.has(metadata.cost.allowancePeriodId);
      if (metadata.userId !== undefined) {
        if (!matchesTargetArtifact && !matchesTargetAllowance) return Effect.succeed(false);
        return Effect.fail(ambiguousObjectOwnership(object.key, "contradictory attempt ownership"));
      }
      if (matchesTargetAllowance) return Effect.succeed(true);
      if (!matchesTargetArtifact) return Effect.succeed(false);
      return Effect.fail(ambiguousObjectOwnership(object.key, "contradictory attempt ownership"));
    }),
  );

const verifyConcreteObject = <E>(
  bucket: R2Bucket,
  key: string,
  validate: (object: R2Object) => Effect.Effect<void, E>,
) =>
  attempt("removeObjects", () => bucket.head(key)).pipe(
    Effect.flatMap((object) =>
      object === null ? Effect.succeed([]) : validate(object).pipe(Effect.as([key])),
    ),
  );

const decodeArtifactMetadata = (object: R2Object) =>
  Schema.decodeUnknownEffect(ArtifactMetadata)(object.customMetadata?.osfo).pipe(
    Effect.mapError((cause) => ambiguousObjectOwnership(object.key, cause)),
  );

const decodeAttemptMetadata = (object: R2Object) =>
  Schema.decodeUnknownEffect(AttemptMetadata)(object.customMetadata?.osfo).pipe(
    Effect.mapError((cause) => ambiguousObjectOwnership(object.key, cause)),
  );

const ambiguousObjectOwnership = (key: string, cause: unknown) =>
  new AccountDeletion.AccountDeletionUnavailable({
    cause,
    message: `R2 ownership evidence is invalid for ${key}`,
    operation: "removeObjects",
  });

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new AccountDeletion.AccountDeletionUnavailable({
        cause,
        message: "R2 account deletion is unavailable",
        operation,
      }),
  });

export * as AccountDeletionCloudflare from "./account-deletion";
