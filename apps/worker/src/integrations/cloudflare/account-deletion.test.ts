/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

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

it.effect("removes an interrupted document attempt without a retained artifact", () => {
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

it.effect("removes an owned document body and its attempt sidecar through shared keys", () => {
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
    },
  });

  return make(files, artifacts, () => Effect.succeed(new Set()))
    .remove(userId, Effect.void)
    .pipe(
      Effect.andThen(
        Effect.sync(() => {
          expect(deleted).toContain(contentKey);
          expect(deleted).toContain(attemptKey);
        }),
      ),
    );
});

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
    list: ({ prefix }: R2ListOptions) =>
      Promise.resolve({
        delimitedPrefixes: [],
        objects: options.objectsByPrefix?.[prefix ?? ""] ?? [],
        truncated: false as const,
      }),
  };
  // SAFETY: Account deletion uses only the list and delete methods supplied above.
  // oxlint-disable-next-line osfo/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The fake intentionally implements this test's narrow R2 seam only.
  return bucket as unknown as R2Bucket;
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
