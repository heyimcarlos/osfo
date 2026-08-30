import { Array, Effect, Schema } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import { QualificationContext } from "../../domain/qualification-context";
import { AccountDeletion } from "../../services/account-deletion";
import { DocumentQualificationAuthority } from "./document-qualification-authority";
import { qualificationChecksum } from "../../qualification/qualification-checksum";
import {
  attemptKeyForContentKey,
  artifactAttemptPrefix,
  artifactCostPrefix,
  contentKeyForAttemptKey,
  contentIdForContentKey,
  documentKeysForOwnerKey,
  documentAttemptPrefix,
  documentContentPrefix,
  ownerKeyFor,
  ownerPrefixFor,
  qualificationReceiptKeyFor,
} from "./document-storage-keys";
import { DocumentOwnershipIndex } from "./document-ownership-index";

/* oxlint-disable eslint/no-underscore-dangle -- Decoded Result values use the _tag discriminator. */

const ArtifactMetadata = Schema.fromJsonString(
  Schema.Struct({
    qualificationContext: Schema.optionalKey(QualificationContext),
    userId: UserId,
  }),
);
const decodeQualificationReceipt = Schema.decodeUnknownOption(
  Schema.fromJsonString(DocumentQualificationAuthority.QualificationDocumentObjectReceipt),
);
const AttemptMetadata = Schema.fromJsonString(
  Schema.Struct({
    cost: Schema.Union([
      Schema.Struct({ allowancePeriodId: AllowancePeriodId }),
      Schema.TaggedStruct("ProvenNoUse", {}),
      Schema.TaggedStruct("Incurred", { allowancePeriodId: AllowancePeriodId }),
    ]),
    userId: Schema.optionalKey(UserId),
  }),
);
const ArtifactCostMetadata = Schema.fromJsonString(
  Schema.Struct({
    cost: Schema.TaggedStruct("Incurred", {
      allowancePeriodId: AllowancePeriodId,
      basis: Schema.Literals(["conservative", "observed"]),
      providerOperationId: Schema.String.check(Schema.isMinLength(1)),
      usdMicros: Schema.BigIntFromString,
    }),
    userId: UserId,
  }),
);

/** Build idempotent R2 erasure for User files and generated-document evidence. */
export const make = (
  files: R2Bucket,
  artifacts: R2Bucket,
  readAllowanceEvidence: (userId: UserId) => Effect.Effect<
    {
      readonly allowancePeriodIds: ReadonlySet<AllowancePeriodId>;
      readonly reconciledArtifactProviderOperationIds: ReadonlySet<string>;
    },
    AccountDeletion.AccountDeletionUnavailable
  >,
): AccountDeletion.PortInterface["objects"] => ({
  remove: (userId, authorizeDelete) =>
    Effect.gen(function* () {
      const allowanceEvidence = yield* readAllowanceEvidence(userId);
      const artifactKeys = yield* planArtifactDeletion(
        artifacts,
        userId,
        allowanceEvidence,
        authorizeDelete,
      );
      yield* deletePrefix(files, `users/${encodeURIComponent(userId)}/`, authorizeDelete);
      yield* deleteObjectKeys(artifacts, artifactKeys, authorizeDelete);
    }),
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
  yield* authorizeDelete;
  const page = yield* attempt("removeObjects", () =>
    bucket.list(cursor === undefined ? { prefix } : { cursor, prefix }),
  );
  if (page.objects.length > 0) {
    yield* authorizeDelete;
    yield* attempt("removeObjects", () => bucket.delete(page.objects.map(({ key }) => key)));
  }
  if (page.truncated) yield* deletePrefix(bucket, prefix, authorizeDelete, page.cursor);
});

const planArtifactDeletion: (
  bucket: R2Bucket,
  userId: UserId,
  allowanceEvidence: {
    readonly allowancePeriodIds: ReadonlySet<AllowancePeriodId>;
    readonly reconciledArtifactProviderOperationIds: ReadonlySet<string>;
  },
  authorizeDelete: Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable>,
) => Effect.Effect<ReadonlyArray<string>, AccountDeletion.AccountDeletionUnavailable> = Effect.fn(
  "AccountDeletionCloudflare.planArtifactDeletion",
)(function* (
  bucket: R2Bucket,
  userId: UserId,
  allowanceEvidence: {
    readonly allowancePeriodIds: ReadonlySet<AllowancePeriodId>;
    readonly reconciledArtifactProviderOperationIds: ReadonlySet<string>;
  },
  authorizeDelete: Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable>,
) {
  const ownerObjects = yield* discoverObjects(bucket, ownerPrefixFor(userId), authorizeDelete);
  const indexedTargets = yield* Effect.forEach(ownerObjects, (object) =>
    decodeOwnerMarker(object, userId),
  );
  const contentObjects = yield* discoverObjects(bucket, documentContentPrefix, authorizeDelete);
  const attemptObjects = [
    ...(yield* discoverObjects(bucket, artifactAttemptPrefix, authorizeDelete)),
    ...(yield* discoverObjects(bucket, documentAttemptPrefix, authorizeDelete)),
  ];
  const costObjects = yield* discoverObjects(bucket, artifactCostPrefix, authorizeDelete);
  const decodedCostObjects = yield* Effect.forEach(costObjects, (object) =>
    decodeArtifactCostMetadata(object).pipe(Effect.map((metadata) => ({ metadata, object }))),
  );
  const targetCostKeys = decodedCostObjects.flatMap(({ metadata, object }) =>
    metadata.userId === userId ? [object.key] : [],
  );
  const legacyContentTargets = yield* Effect.forEach(contentObjects, (object) => {
    const decoded = Schema.decodeUnknownResult(ArtifactMetadata)(object.customMetadata?.osfo);
    if (decoded._tag === "Success" && decoded.success.userId === userId) {
      const attemptKey = attemptKeyForContentKey(object.key);
      if (attemptKey === undefined) {
        return Effect.fail(ambiguousObjectOwnership(object.key, "malformed artifact key"));
      }
      return Effect.succeed([{ attemptKey, contentKey: object.key }]);
    }
    if (
      decoded._tag === "Failure" &&
      indexedTargets.some(({ contentKey }) => contentKey === object.key)
    ) {
      return Effect.fail(ambiguousObjectOwnership(object.key, decoded.failure));
    }
    return Effect.succeed([]);
  }).pipe(Effect.map((groups) => groups.flat()));
  const pairedContentKeys = new Set([
    ...indexedTargets.map(({ contentKey }) => contentKey),
    ...legacyContentTargets.map(({ contentKey }) => contentKey),
  ]);
  const pairedAttemptKeys = new Set([
    ...indexedTargets.map(({ attemptKey }) => attemptKey),
    ...legacyContentTargets.map(({ attemptKey }) => attemptKey),
  ]);
  const discoveredAttemptTargets = yield* Effect.forEach(attemptObjects, (object) => {
    const decoded = Schema.decodeUnknownResult(AttemptMetadata)(object.customMetadata?.osfo);
    if (decoded._tag === "Failure") {
      if (pairedAttemptKeys.has(object.key)) {
        return Effect.fail(ambiguousObjectOwnership(object.key, decoded.failure));
      }
      return Effect.succeed([]);
    }
    return selectDecodedAttemptEvidence(
      object.key,
      decoded.success,
      userId,
      allowanceEvidence.allowancePeriodIds,
      pairedAttemptKeys,
    ).pipe(
      Effect.map((owned) =>
        owned
          ? [
              {
                attemptKey: object.key,
                contentKey: contentKeyForAttemptKey(object.key),
              },
            ]
          : [],
      ),
    );
  }).pipe(Effect.map((groups) => groups.flat()));
  const targetContentKeys = new Set([
    ...pairedContentKeys,
    ...discoveredAttemptTargets.flatMap(({ contentKey }) =>
      contentKey === undefined ? [] : [contentKey],
    ),
  ]);
  const targetAttemptKeys = new Set([
    ...pairedAttemptKeys,
    ...discoveredAttemptTargets.map(({ attemptKey }) => attemptKey),
  ]);
  yield* Effect.forEach(
    contentObjects.filter(({ key }) => targetContentKeys.has(key)),
    (object) => {
      const decoded = Schema.decodeUnknownResult(ArtifactMetadata)(object.customMetadata?.osfo);
      if (decoded._tag === "Failure") {
        return Effect.fail(ambiguousObjectOwnership(object.key, decoded.failure));
      }
      return decoded.success.userId === userId
        ? Effect.void
        : Effect.fail(ambiguousObjectOwnership(object.key, "contradictory artifact ownership"));
    },
    { discard: true },
  );

  const ownerKeys = yield* Effect.forEach(indexedTargets, ({ ownerKey }) =>
    verifyConcreteObject(bucket, ownerKey, authorizeDelete, (object) =>
      decodeOwnerMarker(object, userId).pipe(Effect.asVoid),
    ),
  );
  const verifiedContent = yield* Effect.forEach([...targetContentKeys], (contentKey) =>
    authorizeDelete.pipe(
      Effect.andThen(attempt("removeObjects", () => bucket.head(contentKey))),
      Effect.flatMap((object) => {
        if (object === null) return Effect.succeed({ contentKeys: [], receiptKeys: [] });
        return decodeArtifactMetadata(object).pipe(
          Effect.flatMap((metadata) => {
            if (metadata.userId !== userId) {
              return Effect.fail(
                ambiguousObjectOwnership(contentKey, "artifact ownership changed before deletion"),
              );
            }
            const context = metadata.qualificationContext;
            if (context === undefined) {
              return Effect.succeed({ contentKeys: [contentKey], receiptKeys: [] });
            }
            const contentId = contentIdForContentKey(contentKey);
            if (contentId === undefined) {
              return Effect.fail(ambiguousObjectOwnership(contentKey, "malformed artifact key"));
            }
            const receiptKey = qualificationReceiptKeyFor(
              context.executionId,
              context.runId,
              contentId,
            );
            return verifyQualificationReceipt(
              bucket,
              receiptKey,
              contentId,
              context,
              object.customMetadata?.osfo ?? "",
              authorizeDelete,
            ).pipe(Effect.as({ contentKeys: [contentKey], receiptKeys: [receiptKey] }));
          }),
        );
      }),
    ),
  );
  const attemptKeys = yield* Effect.forEach([...targetAttemptKeys], (key) =>
    verifyConcreteObject(bucket, key, authorizeDelete, (object) =>
      selectAttemptEvidence(
        object,
        userId,
        allowanceEvidence.allowancePeriodIds,
        targetAttemptKeys,
      ).pipe(
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
  const costKeys = yield* Effect.forEach(targetCostKeys, (key) =>
    verifyConcreteObject(bucket, key, authorizeDelete, (object) =>
      decodeArtifactCostMetadata(object).pipe(
        Effect.flatMap((metadata) =>
          metadata.userId !== userId
            ? Effect.fail(
                ambiguousObjectOwnership(key, "artifact cost ownership changed before deletion"),
              )
            : allowanceEvidence.reconciledArtifactProviderOperationIds.has(
                  metadata.cost.providerOperationId,
                )
              ? Effect.void
              : Effect.fail(
                  ambiguousObjectOwnership(
                    key,
                    "artifact cost is not yet proven in Allowance Usage",
                  ),
                ),
        ),
      ),
    ),
  );
  return [
    ...ownerKeys.flat(),
    ...verifiedContent.flatMap(({ contentKeys }) => contentKeys),
    ...attemptKeys.flat(),
    ...costKeys.flat(),
    ...verifiedContent.flatMap(({ receiptKeys }) => receiptKeys),
  ];
});

const verifyQualificationReceipt = Effect.fn(
  "AccountDeletionCloudflare.verifyQualificationReceipt",
)(function* (
  bucket: R2Bucket,
  key: string,
  contentId: string,
  context: QualificationContext,
  encodedArtifactMetadata: string,
  authorizeDelete: Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable>,
) {
  yield* authorizeDelete;
  const object = yield* attempt("removeObjects", () => bucket.get(key));
  if (object === null) return yield* Effect.void;
  const encoded = yield* attempt("removeObjects", () => object.text());
  const decoded = decodeQualificationReceipt(encoded);
  if (decoded._tag === "None") {
    return yield* ambiguousObjectOwnership(key, "malformed qualification receipt");
  }
  const receipt = decoded.value;
  const { artifactChecksum, ...content } = receipt;
  const metadata = object.customMetadata;
  const bodySha256 = yield* sha256Hex(encoded);
  const accountedMetadataSha256 = yield* sha256Hex(encodedArtifactMetadata);
  if (
    receipt.artifactId !== key ||
    receipt.attemptId !== context.attemptId ||
    receipt.executionId !== context.executionId ||
    receipt.objectId !== contentId ||
    receipt.planChecksum !== context.planChecksum ||
    receipt.rootId !== context.rootId ||
    receipt.runId !== context.runId ||
    receipt.accountedMetadataSha256 !== accountedMetadataSha256 ||
    artifactChecksum !== qualificationChecksum(content) ||
    metadata?.["osfo-artifact-checksum"] !== artifactChecksum ||
    metadata["osfo-body-sha256"] !== bodySha256 ||
    metadata["osfo-execution-id"] !== context.executionId ||
    metadata["osfo-kind"] !== "qualification-document-object-receipt-v1" ||
    metadata["osfo-object-id"] !== contentId ||
    metadata["osfo-plan-checksum"] !== context.planChecksum ||
    metadata["osfo-root-id"] !== context.rootId ||
    metadata["osfo-run-id"] !== context.runId
  ) {
    return yield* ambiguousObjectOwnership(key, "foreign qualification receipt");
  }
  return yield* Effect.void;
});

const sha256Hex = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map((digest) =>
      globalThis.Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    ),
  );

const deleteObjectKeys = Effect.fn("AccountDeletionCloudflare.deleteObjectKeys")(function* (
  bucket: R2Bucket,
  keys: ReadonlyArray<string>,
  authorizeDelete: Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable>,
) {
  yield* Effect.forEach(
    Array.chunksOf(keys, 1_000),
    (keyBatch) =>
      authorizeDelete.pipe(Effect.andThen(attempt("removeObjects", () => bucket.delete(keyBatch)))),
    { discard: true },
  );
});

const discoverObjects: (
  bucket: R2Bucket,
  prefix: string,
  authorizeDelete: Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable>,
  cursor?: string,
) => Effect.Effect<ReadonlyArray<R2Object>, AccountDeletion.AccountDeletionUnavailable> = Effect.fn(
  "AccountDeletionCloudflare.discoverObjects",
)(function* (
  bucket: R2Bucket,
  prefix: string,
  authorizeDelete: Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable>,
  cursor?: string,
) {
  yield* authorizeDelete;
  const page = yield* attempt("removeObjects", () =>
    bucket.list(
      cursor === undefined
        ? { include: ["customMetadata"], prefix }
        : { cursor, include: ["customMetadata"], prefix },
    ),
  );
  if (page.truncated) {
    return [
      ...page.objects,
      ...(yield* discoverObjects(bucket, prefix, authorizeDelete, page.cursor)),
    ];
  }
  return page.objects;
});

const decodeOwnerMarker = (object: R2Object, userId: UserId) => {
  const metadata = DocumentOwnershipIndex.decode(object);
  if (metadata._tag === "Failure") {
    return Effect.fail(ambiguousObjectOwnership(object.key, metadata.failure));
  }
  const keys = documentKeysForOwnerKey(userId, object.key);
  if (
    keys === undefined ||
    metadata.success.userId !== userId ||
    ownerKeyFor(userId, metadata.success.contentId) !== object.key
  ) {
    return Effect.fail(ambiguousObjectOwnership(object.key, "invalid ownership marker"));
  }
  return Effect.succeed(keys);
};

const selectAttemptEvidence = (
  object: R2Object,
  userId: UserId,
  allowancePeriodIds: ReadonlySet<AllowancePeriodId>,
  pairedAttemptKeys: ReadonlySet<string>,
) =>
  decodeAttemptMetadata(object).pipe(
    Effect.flatMap((metadata) =>
      selectDecodedAttemptEvidence(
        object.key,
        metadata,
        userId,
        allowancePeriodIds,
        pairedAttemptKeys,
      ),
    ),
  );

const selectDecodedAttemptEvidence = (
  key: string,
  metadata: typeof AttemptMetadata.Type,
  userId: UserId,
  allowancePeriodIds: ReadonlySet<AllowancePeriodId>,
  pairedAttemptKeys: ReadonlySet<string>,
): Effect.Effect<boolean, AccountDeletion.AccountDeletionUnavailable> => {
  if (metadata.userId === userId) return Effect.succeed(true);
  const matchesTargetArtifact = pairedAttemptKeys.has(key);
  const allowancePeriodId =
    "allowancePeriodId" in metadata.cost ? metadata.cost.allowancePeriodId : null;
  const matchesTargetAllowance =
    allowancePeriodId !== null && allowancePeriodIds.has(allowancePeriodId);
  if (metadata.userId !== undefined) {
    if (!matchesTargetArtifact && !matchesTargetAllowance) return Effect.succeed(false);
    return Effect.fail(ambiguousObjectOwnership(key, "contradictory attempt ownership"));
  }
  if (matchesTargetAllowance) return Effect.succeed(true);
  if (!matchesTargetArtifact) return Effect.succeed(false);
  return Effect.fail(ambiguousObjectOwnership(key, "contradictory attempt ownership"));
};

const verifyConcreteObject = <E>(
  bucket: R2Bucket,
  key: string,
  authorizeDelete: Effect.Effect<void, AccountDeletion.AccountDeletionUnavailable>,
  validate: (object: R2Object) => Effect.Effect<void, E>,
) =>
  authorizeDelete.pipe(
    Effect.andThen(attempt("removeObjects", () => bucket.head(key))),
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

const decodeArtifactCostMetadata = (object: R2Object) =>
  Schema.decodeUnknownEffect(ArtifactCostMetadata)(object.customMetadata?.osfo).pipe(
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
