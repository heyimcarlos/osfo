import { Effect, Option, Schema } from "effect";

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
  cursor?: string,
) => Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable> = Effect.fn(
  "AccountDeletionCloudflare.deleteArtifacts",
)(function* (
  bucket: R2Bucket,
  userId: UserId,
  allowancePeriodIds: ReadonlySet<AllowancePeriodId>,
  authorizeDelete: Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable>,
  cursor?: string,
) {
  const page = yield* attempt("removeObjects", () =>
    bucket.list(
      cursor === undefined
        ? { include: ["customMetadata"], prefix: documentContentPrefix }
        : { cursor, include: ["customMetadata"], prefix: documentContentPrefix },
    ),
  );
  const keys = page.objects.flatMap((object) => {
    const metadata = Option.flatMap(
      Option.fromNullishOr(object.customMetadata?.osfo),
      Schema.decodeUnknownOption(ArtifactMetadata),
    );
    if (Option.isNone(metadata) || metadata.value.userId !== userId) return [];
    const attemptKey = attemptKeyForContentKey(object.key);
    return attemptKey === undefined ? [] : [object.key, attemptKey];
  });
  if (keys.length > 0) {
    yield* authorizeDelete;
    yield* attempt("removeObjects", () => bucket.delete(keys));
  }
  if (page.truncated) {
    yield* deleteArtifacts(bucket, userId, allowancePeriodIds, authorizeDelete, page.cursor);
    return;
  }
  yield* deleteAttemptEvidence(bucket, userId, allowancePeriodIds, authorizeDelete);
});

const deleteAttemptEvidence: (
  bucket: R2Bucket,
  userId: UserId,
  allowancePeriodIds: ReadonlySet<AllowancePeriodId>,
  authorizeDelete: Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable>,
  cursor?: string,
) => Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable> = Effect.fn(
  "AccountDeletionCloudflare.deleteAttemptEvidence",
)(function* (
  bucket: R2Bucket,
  userId: UserId,
  allowancePeriodIds: ReadonlySet<AllowancePeriodId>,
  authorizeDelete: Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable>,
  cursor?: string,
) {
  const page = yield* attempt("removeObjects", () =>
    bucket.list(
      cursor === undefined
        ? { include: ["customMetadata"], prefix: documentAttemptPrefix }
        : { cursor, include: ["customMetadata"], prefix: documentAttemptPrefix },
    ),
  );
  const keys = page.objects.flatMap((object) => {
    const metadata = Option.flatMap(
      Option.fromNullishOr(object.customMetadata?.osfo),
      Schema.decodeUnknownOption(AttemptMetadata),
    );
    return Option.isSome(metadata) &&
      (metadata.value.userId === userId ||
        allowancePeriodIds.has(metadata.value.cost.allowancePeriodId))
      ? [object.key]
      : [];
  });
  if (keys.length > 0) {
    yield* authorizeDelete;
    yield* attempt("removeObjects", () => bucket.delete(keys));
  }
  if (page.truncated) {
    yield* deleteAttemptEvidence(bucket, userId, allowancePeriodIds, authorizeDelete, page.cursor);
  }
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
