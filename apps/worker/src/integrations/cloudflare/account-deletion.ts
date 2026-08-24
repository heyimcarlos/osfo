import { Effect, Option, Schema } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import { AccountDeletion } from "../../services/account-deletion";

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
): AccountDeletion.Dependencies["objects"] => ({
  remove: (userId) =>
    readAllowancePeriodIds(userId).pipe(
      Effect.flatMap((allowancePeriodIds) =>
        deletePrefix(files, `users/${encodeURIComponent(userId)}/`).pipe(
          Effect.andThen(deleteArtifacts(artifacts, userId, allowancePeriodIds)),
        ),
      ),
    ),
});

const deletePrefix: (
  bucket: R2Bucket,
  prefix: string,
  cursor?: string,
) => Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable> = Effect.fn(
  "AccountDeletionCloudflare.deletePrefix",
)(function* (bucket: R2Bucket, prefix: string, cursor?: string) {
  const page = yield* attempt("removeObjects", () =>
    bucket.list(cursor === undefined ? { prefix } : { cursor, prefix }),
  );
  if (page.objects.length > 0) {
    yield* attempt("removeObjects", () => bucket.delete(page.objects.map(({ key }) => key)));
  }
  if (page.truncated) yield* deletePrefix(bucket, prefix, page.cursor);
});

const deleteArtifacts: (
  bucket: R2Bucket,
  userId: UserId,
  allowancePeriodIds: ReadonlySet<AllowancePeriodId>,
  cursor?: string,
) => Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable> = Effect.fn(
  "AccountDeletionCloudflare.deleteArtifacts",
)(function* (
  bucket: R2Bucket,
  userId: UserId,
  allowancePeriodIds: ReadonlySet<AllowancePeriodId>,
  cursor?: string,
) {
  const page = yield* attempt("removeObjects", () =>
    bucket.list(
      cursor === undefined
        ? { include: ["customMetadata"], prefix: "client-content/" }
        : { cursor, include: ["customMetadata"], prefix: "client-content/" },
    ),
  );
  const keys = page.objects.flatMap((object) => {
    const metadata = Option.flatMap(
      Option.fromNullishOr(object.customMetadata?.osfo),
      Schema.decodeUnknownOption(ArtifactMetadata),
    );
    if (Option.isNone(metadata) || metadata.value.userId !== userId) return [];
    const encodedContentId = object.key.slice("client-content/".length);
    return [object.key, `document-attempts/${encodedContentId}`];
  });
  if (keys.length > 0) yield* attempt("removeObjects", () => bucket.delete(keys));
  if (page.truncated) {
    yield* deleteArtifacts(bucket, userId, allowancePeriodIds, page.cursor);
    return;
  }
  yield* deleteAttemptEvidence(bucket, userId, allowancePeriodIds);
});

const deleteAttemptEvidence: (
  bucket: R2Bucket,
  userId: UserId,
  allowancePeriodIds: ReadonlySet<AllowancePeriodId>,
  cursor?: string,
) => Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable> = Effect.fn(
  "AccountDeletionCloudflare.deleteAttemptEvidence",
)(function* (
  bucket: R2Bucket,
  userId: UserId,
  allowancePeriodIds: ReadonlySet<AllowancePeriodId>,
  cursor?: string,
) {
  const page = yield* attempt("removeObjects", () =>
    bucket.list(
      cursor === undefined
        ? { include: ["customMetadata"], prefix: "document-attempts/" }
        : { cursor, include: ["customMetadata"], prefix: "document-attempts/" },
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
  if (keys.length > 0) yield* attempt("removeObjects", () => bucket.delete(keys));
  if (page.truncated) {
    yield* deleteAttemptEvidence(bucket, userId, allowancePeriodIds, page.cursor);
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
