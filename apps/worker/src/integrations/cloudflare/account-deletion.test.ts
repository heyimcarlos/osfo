/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import { ContentId } from "../../domain/client-content";
import { AccountDeletion } from "../../services/account-deletion";
import { make } from "./account-deletion";
import {
  attemptKeyFor,
  contentKeyFor,
  documentAttemptPrefix,
  documentContentPrefix,
} from "./document-storage-keys";

it.effect("uses an allowance period to remove legacy attempt evidence without a user id", () => {
  const deleted: Array<string> = [];
  const userId = UserId.make("user-1");
  const files = bucketStub({ deleted });
  const artifacts = bucketStub({
    deleted,
    objectsByPrefix: {
      [documentAttemptPrefix]: [
        {
          customMetadata: {
            osfo: JSON.stringify({
              cost: { allowancePeriodId: "period-1" },
            }),
          },
          key: "document-attempts/orphaned-content",
        },
      ],
    },
  });

  return make(files, artifacts, () => Effect.succeed(new Set([AllowancePeriodId.make("period-1")])))
    .remove(userId, Effect.void)
    .pipe(
      Effect.andThen(
        Effect.sync(() => {
          expect(deleted).toContain("document-attempts/orphaned-content");
        }),
      ),
    );
});

it.effect("removes attempt evidence explicitly owned by the target user", () => {
  const deleted: Array<string> = [];
  const key = attemptKeyFor(ContentId.make("target-content"));
  const files = bucketStub({ deleted });
  const artifacts = bucketStub({
    deleted,
    objectsByPrefix: {
      [documentAttemptPrefix]: [
        {
          customMetadata: {
            osfo: JSON.stringify({
              cost: { allowancePeriodId: "unrelated-period" },
              userId: "user-1",
            }),
          },
          key,
        },
      ],
    },
  });

  return make(files, artifacts, () => Effect.succeed(new Set()))
    .remove(UserId.make("user-1"), Effect.void)
    .pipe(
      Effect.andThen(
        Effect.sync(() => {
          expect(deleted).toEqual([key]);
        }),
      ),
    );
});

it.effect("fails closed when explicit ownership contradicts a target allowance", () => {
  const deleted: Array<string> = [];
  const files = bucketStub({ deleted });
  const artifacts = bucketStub({
    deleted,
    objectsByPrefix: {
      [documentAttemptPrefix]: [
        {
          customMetadata: {
            osfo: JSON.stringify({
              cost: { allowancePeriodId: "period-1" },
              userId: "user-2",
            }),
          },
          key: attemptKeyFor(ContentId.make("contradictory-content")),
        },
      ],
    },
  });

  return make(files, artifacts, () => Effect.succeed(new Set([AllowancePeriodId.make("period-1")])))
    .remove(UserId.make("user-1"), Effect.void)
    .pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          expect(deleted).toEqual([]);
        }),
      ),
    );
});

it.effect("removes a canonical target-owned document body and attempt sidecar", () => {
  const deleted: Array<string> = [];
  const userId = UserId.make("user-1");
  const contentId = ContentId.make("content-1");
  const contentKey = contentKeyFor(contentId);
  const attemptKey = attemptKeyFor(contentId);
  const files = bucketStub({ deleted });
  const artifacts = bucketStub({
    deleted,
    objectsByPrefix: {
      [documentContentPrefix]: [
        {
          customMetadata: { osfo: JSON.stringify({ userId }) },
          key: contentKey,
        },
      ],
      [documentAttemptPrefix]: [
        {
          customMetadata: {
            osfo: JSON.stringify({
              cost: { allowancePeriodId: "period-1" },
              userId,
            }),
          },
          key: attemptKey,
        },
      ],
    },
  });

  return make(files, artifacts, () => Effect.succeed(new Set([AllowancePeriodId.make("period-1")])))
    .remove(userId, Effect.void)
    .pipe(
      Effect.andThen(
        Effect.sync(() => {
          expect(deleted).toEqual([contentKey, attemptKey]);
        }),
      ),
    );
});

it.effect("preserves a target document pair when its attempt metadata is malformed", () => {
  const contentId = ContentId.make("malformed-attempt-content");
  return expectPairedOwnershipFailure({
    attempt: {
      customMetadata: { osfo: "not-json" },
      key: attemptKeyFor(contentId),
    },
    contentId,
  });
});

it.effect("preserves a target document pair when its attempt names another user", () => {
  const contentId = ContentId.make("other-user-attempt-content");
  return expectPairedOwnershipFailure({
    attempt: {
      customMetadata: {
        osfo: JSON.stringify({
          cost: { allowancePeriodId: "unrelated-period" },
          userId: "user-2",
        }),
      },
      key: attemptKeyFor(contentId),
    },
    contentId,
  });
});

it.effect("preserves canonically owned unrelated document evidence", () => {
  const deleted: Array<string> = [];
  const files = bucketStub({ deleted });
  const artifacts = bucketStub({
    deleted,
    objectsByPrefix: {
      [documentContentPrefix]: [
        {
          customMetadata: { osfo: JSON.stringify({ userId: "user-2" }) },
          key: contentKeyFor(ContentId.make("unrelated-content")),
        },
      ],
      [documentAttemptPrefix]: [
        {
          customMetadata: {
            osfo: JSON.stringify({
              cost: { allowancePeriodId: "unrelated-period" },
              userId: "user-2",
            }),
          },
          key: attemptKeyFor(ContentId.make("unrelated-content")),
        },
      ],
    },
  });

  return make(files, artifacts, () => Effect.succeed(new Set()))
    .remove(UserId.make("user-1"), Effect.void)
    .pipe(
      Effect.andThen(
        Effect.sync(() => {
          expect(deleted).toEqual([]);
        }),
      ),
    );
});

it.effect("fails closed on malformed artifact ownership metadata", () =>
  expectOwnershipFailure({
    prefix: documentContentPrefix,
    object: { customMetadata: { osfo: "not-json" }, key: contentKeyFor(ContentId.make("bad")) },
  }),
);

it.effect("fails closed when an owned artifact key is not canonical", () =>
  expectOwnershipFailure({
    prefix: documentContentPrefix,
    object: {
      customMetadata: { osfo: JSON.stringify({ userId: "user-1" }) },
      key: "documents/not-a-content-key",
    },
  }),
);

it.effect("fails closed on malformed attempt ownership metadata", () =>
  expectOwnershipFailure({
    prefix: documentAttemptPrefix,
    object: { customMetadata: { osfo: "{}" }, key: "document-attempts/bad" },
  }),
);

it.effect("rechecks authority before every paginated R2 delete", () => {
  const deleted: Array<string> = [];
  const userId = UserId.make("user-1");
  let authorized = true;
  let checks = 0;
  const files = paginatedBucketStub(deleted, () => {
    authorized = false;
  });
  const artifacts = bucketStub({ deleted });

  return make(files, artifacts, () => Effect.succeed(new Set()))
    .remove(
      userId,
      Effect.suspend(() => {
        checks += 1;
        if (!authorized) {
          return Effect.fail(
            new AccountDeletion.AccountDeletionUnavailable({
              cause: userId,
              message: "authority changed",
              operation: "recheckDeletionAuthority",
            }),
          );
        }
        return Effect.void;
      }),
    )
    .pipe(
      Effect.result,
      Effect.andThen(
        Effect.sync(() => {
          expect(checks).toBe(2);
          expect(deleted).toEqual([`users/${userId}/page-1`]);
        }),
      ),
    );
});

const bucketStub = (options: {
  readonly deleted: Array<string>;
  readonly objectsByPrefix?: Readonly<Record<string, ReadonlyArray<Partial<R2Object>>>>;
}) => {
  const bucket = {
    delete: (keys: string | Array<string>) => {
      options.deleted.push(...(Array.isArray(keys) ? keys : [keys]));
      return Promise.resolve();
    },
    head: (key: string) =>
      Promise.resolve(
        Object.values(options.objectsByPrefix ?? {})
          .flat()
          .find((object) => object.key === key) ?? null,
      ),
    list: ({ prefix }: R2ListOptions) =>
      Promise.resolve({
        delimitedPrefixes: [],
        objects: options.objectsByPrefix?.[prefix ?? ""] ?? [],
        truncated: false as const,
      }),
  };
  // SAFETY: Account deletion uses only the head, list, and delete methods supplied above.
  // oxlint-disable-next-line osfo/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The fake intentionally implements this test's narrow R2 seam only.
  return bucket as unknown as R2Bucket;
};

const expectOwnershipFailure = (input: {
  readonly object: Partial<R2Object>;
  readonly prefix: string;
}) => {
  const deleted: Array<string> = [];
  const files = bucketStub({ deleted });
  const artifacts = bucketStub({
    deleted,
    objectsByPrefix: { [input.prefix]: [input.object] },
  });
  return make(files, artifacts, () => Effect.succeed(new Set()))
    .remove(UserId.make("user-1"), Effect.void)
    .pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          expect(deleted).toEqual([]);
        }),
      ),
    );
};

const expectPairedOwnershipFailure = (input: {
  readonly attempt: Partial<R2Object>;
  readonly contentId: ContentId;
}) => {
  const deleted: Array<string> = [];
  const files = bucketStub({ deleted });
  const artifacts = bucketStub({
    deleted,
    objectsByPrefix: {
      [documentContentPrefix]: [
        {
          customMetadata: { osfo: JSON.stringify({ userId: "user-1" }) },
          key: contentKeyFor(input.contentId),
        },
      ],
      [documentAttemptPrefix]: [input.attempt],
    },
  });
  return make(files, artifacts, () => Effect.succeed(new Set()))
    .remove(UserId.make("user-1"), Effect.void)
    .pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          expect(deleted).toEqual([]);
        }),
      ),
    );
};

const paginatedBucketStub = (deleted: Array<string>, afterFirstDelete: () => void) => {
  const bucket = {
    delete: (keys: string | Array<string>) => {
      deleted.push(...(Array.isArray(keys) ? keys : [keys]));
      if (deleted.length === 1) afterFirstDelete();
      return Promise.resolve();
    },
    list: ({ cursor, prefix }: R2ListOptions) =>
      Promise.resolve(
        cursor === undefined
          ? {
              cursor: "page-2",
              delimitedPrefixes: [],
              objects: [{ key: `${prefix}page-1` }],
              truncated: true as const,
            }
          : {
              delimitedPrefixes: [],
              objects: [{ key: `${prefix}page-2` }],
              truncated: false as const,
            },
      ),
  };
  // SAFETY: Account deletion uses only the list and delete methods supplied above.
  // oxlint-disable-next-line osfo/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The fake intentionally implements this test's narrow R2 seam only.
  return bucket as unknown as R2Bucket;
};
