/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import { ContentId } from "../../domain/client-content";
import { AccountDeletion } from "../../services/account-deletion";
import { make } from "./account-deletion";
import {
  artifactCostKeyFor,
  artifactCostPrefix,
  artifactAttemptPrefix,
  attemptKeyFor,
  contentKeyFor,
  documentAttemptPrefix,
  documentContentPrefix,
  ownerKeyFor,
  ownerPrefixFor,
} from "./document-storage-keys";

const deletionEvidence = (
  allowancePeriodIds: ReadonlySet<AllowancePeriodId> = new Set(),
  reconciledArtifactProviderOperationIds: ReadonlySet<string> = new Set(),
) => Effect.succeed({ allowancePeriodIds, reconciledArtifactProviderOperationIds });

it.effect("removes immutable artifact cost evidence owned by the target user", () => {
  const deleted: Array<string> = [];
  const contentId = ContentId.make("artifact:toolCall:cost-evidence");
  const key = artifactCostKeyFor(contentId, "artifact:provider-operation");
  const files = bucketStub({ deleted });
  const artifacts = bucketStub({
    deleted,
    objectsByPrefix: {
      [artifactCostPrefix]: [
        {
          customMetadata: {
            osfo: JSON.stringify({
              cost: {
                _tag: "Incurred",
                allowancePeriodId: "period-1",
                basis: "conservative",
                providerOperationId: "artifact:provider-operation",
                usdMicros: "50000",
              },
              userId: "user-1",
            }),
          },
          key,
        },
      ],
    },
  });

  return make(files, artifacts, () =>
    deletionEvidence(new Set(), new Set(["artifact:provider-operation"])),
  )
    .remove(UserId.make("user-1"), Effect.void)
    .pipe(
      Effect.andThen(
        Effect.sync(() => {
          expect(deleted).toEqual([key]);
        }),
      ),
    );
});

it.effect("retains artifact cost evidence until Allowance Usage proves reconciliation", () => {
  const deleted: Array<string> = [];
  const contentId = ContentId.make("artifact:toolCall:unreconciled-cost");
  const key = artifactCostKeyFor(contentId, "artifact:unreconciled-operation");
  const files = bucketStub({ deleted });
  const artifacts = bucketStub({
    deleted,
    objectsByPrefix: {
      [artifactCostPrefix]: [
        {
          customMetadata: {
            osfo: JSON.stringify({
              cost: {
                _tag: "Incurred",
                allowancePeriodId: "period-1",
                basis: "conservative",
                providerOperationId: "artifact:unreconciled-operation",
                usdMicros: "50000",
              },
              userId: "user-1",
            }),
          },
          key,
        },
      ],
    },
  });

  return Effect.gen(function* () {
    const result = yield* make(files, artifacts, () => deletionEvidence())
      .remove(UserId.make("user-1"), Effect.void)
      .pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
    expect(deleted).not.toContain(key);
  });
});

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

  return make(files, artifacts, () =>
    deletionEvidence(new Set([AllowancePeriodId.make("period-1")])),
  )
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

  return make(files, artifacts, () => deletionEvidence())
    .remove(UserId.make("user-1"), Effect.void)
    .pipe(
      Effect.andThen(
        Effect.sync(() => {
          expect(deleted).toEqual([key]);
        }),
      ),
    );
});

it.effect("removes a claimed artifact attempt with proven no provider use", () => {
  const deleted: Array<string> = [];
  const key = `${artifactAttemptPrefix}${encodeURIComponent("artifact:toolCall:claimed")}`;
  const files = bucketStub({ deleted });
  const artifacts = bucketStub({
    deleted,
    objectsByPrefix: {
      [artifactAttemptPrefix]: [
        {
          customMetadata: {
            osfo: JSON.stringify({ cost: { _tag: "ProvenNoUse" }, userId: "user-1" }),
          },
          key,
        },
      ],
    },
  });

  return make(files, artifacts, () => deletionEvidence())
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

  return make(files, artifacts, () =>
    deletionEvidence(new Set([AllowancePeriodId.make("period-1")])),
  )
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

  return make(files, artifacts, () =>
    deletionEvidence(new Set([AllowancePeriodId.make("period-1")])),
  )
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

  return make(files, artifacts, () => deletionEvidence())
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
    contentId: ContentId.make("bad"),
    prefix: documentContentPrefix,
    object: { customMetadata: { osfo: "not-json" }, key: contentKeyFor(ContentId.make("bad")) },
  }),
);

it.effect("fails closed when an owned artifact key is not canonical", () =>
  expectOwnershipFailure({
    contentId: ContentId.make("bad-owned-key"),
    prefix: documentContentPrefix,
    object: {
      customMetadata: { osfo: JSON.stringify({ userId: "user-1" }) },
      key: `${documentContentPrefix}not-a-content-key`,
    },
  }),
);

it.effect("fails closed on malformed attempt ownership metadata", () =>
  expectOwnershipFailure({
    contentId: ContentId.make("bad-attempt"),
    prefix: documentAttemptPrefix,
    object: {
      customMetadata: { osfo: "{}" },
      key: attemptKeyFor(ContentId.make("bad-attempt")),
    },
  }),
);

it.effect(
  "ignores unrelated malformed legacy objects while deleting indexed target evidence",
  () => {
    const deleted: Array<string> = [];
    const userId = UserId.make("user-1");
    const contentId = ContentId.make("indexed-target");
    const ownerKey = ownerKeyFor(userId, contentId);
    const contentKey = contentKeyFor(contentId);
    const attemptKey = attemptKeyFor(contentId);
    const files = bucketStub({ deleted });
    const artifacts = bucketStub({
      deleted,
      objectsByPrefix: {
        [ownerPrefixFor(userId)]: [ownerMarker(userId, contentId)],
        [documentContentPrefix]: [
          { customMetadata: { osfo: JSON.stringify({ userId }) }, key: contentKey },
          {
            customMetadata: { osfo: "not-json" },
            key: contentKeyFor(ContentId.make("legacy-bad")),
          },
        ],
        [documentAttemptPrefix]: [
          {
            customMetadata: {
              osfo: JSON.stringify({ cost: { allowancePeriodId: "period-1" }, userId }),
            },
            key: attemptKey,
          },
          {
            customMetadata: { osfo: "not-json" },
            key: attemptKeyFor(ContentId.make("legacy-bad")),
          },
        ],
      },
    });

    return make(files, artifacts, () => deletionEvidence())
      .remove(userId, Effect.void)
      .pipe(
        Effect.andThen(
          Effect.sync(() => {
            expect(deleted).toEqual([ownerKey, contentKey, attemptKey]);
          }),
        ),
      );
  },
);

it.effect("rechecks authority before every paginated R2 delete", () => {
  const deleted: Array<string> = [];
  const listed: Array<string | undefined> = [];
  const userId = UserId.make("user-1");
  let authorized = true;
  let checks = 0;
  const files = paginatedBucketStub(deleted, listed, () => {
    authorized = false;
  });
  const artifacts = bucketStub({ deleted });

  return make(files, artifacts, () => deletionEvidence())
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
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          expect(checks).toBe(3);
          expect(listed).toEqual([undefined]);
          expect(deleted).toEqual([`users/${userId}/page-1`]);
        }),
      ),
    );
});

it.effect("rechecks authority before each concrete R2 head verification", () => {
  const calls: Array<string> = [];
  const userId = UserId.make("user-1");
  const contentId = ContentId.make("head-drift-content");
  let authorized = true;
  const files = bucketStub({ deleted: [] });
  const artifacts = authorityDriftArtifactBucketStub(calls, contentId, () => {
    authorized = false;
  });

  return make(files, artifacts, () => deletionEvidence())
    .remove(
      userId,
      revocableAuthority(userId, () => authorized),
    )
    .pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          expect(calls).toEqual([
            `list:${ownerPrefixFor(userId)}`,
            `list:${documentContentPrefix}`,
            `list:${artifactAttemptPrefix}`,
            `list:${documentAttemptPrefix}`,
          ]);
        }),
      ),
    );
});

it.effect("rechecks authority after R2 discovery and before delete", () => {
  const calls: Array<string> = [];
  const userId = UserId.make("user-1");
  let authorized = true;
  const files = authorityDriftFilesBucketStub(calls, userId, () => {
    authorized = false;
  });
  const artifacts = bucketStub({ deleted: [] });

  return make(files, artifacts, () => deletionEvidence())
    .remove(
      userId,
      revocableAuthority(userId, () => authorized),
    )
    .pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          expect(calls).toEqual(["list"]);
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
  readonly contentId: ContentId;
  readonly object: Partial<R2Object>;
  readonly prefix: string;
}) => {
  const deleted: Array<string> = [];
  const files = bucketStub({ deleted });
  const artifacts = bucketStub({
    deleted,
    objectsByPrefix: {
      [ownerPrefixFor(UserId.make("user-1"))]: [
        ownerMarker(UserId.make("user-1"), input.contentId),
      ],
      [input.prefix]: [input.object],
    },
  });
  return make(files, artifacts, () => deletionEvidence())
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

const ownerMarker = (userId: UserId, contentId: ContentId) => ({
  customMetadata: { osfo: JSON.stringify({ contentId, userId }) },
  key: ownerKeyFor(userId, contentId),
});

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
  return make(files, artifacts, () => deletionEvidence())
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

const revocableAuthority = (userId: UserId, authorized: () => boolean) =>
  Effect.suspend(() =>
    authorized()
      ? Effect.void
      : Effect.fail(
          new AccountDeletion.AccountDeletionUnavailable({
            cause: userId,
            message: "authority changed",
            operation: "recheckDeletionAuthority",
          }),
        ),
  );

const paginatedBucketStub = (
  deleted: Array<string>,
  listed: Array<string | undefined>,
  afterFirstDelete: () => void,
) => {
  const bucket = {
    delete: (keys: string | Array<string>) => {
      deleted.push(...(Array.isArray(keys) ? keys : [keys]));
      if (deleted.length === 1) afterFirstDelete();
      return Promise.resolve();
    },
    list: ({ cursor, prefix }: R2ListOptions) => {
      listed.push(cursor);
      return Promise.resolve(
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
      );
    },
  };
  // SAFETY: Account deletion uses only the list and delete methods supplied above.
  // oxlint-disable-next-line osfo/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The fake intentionally implements this test's narrow R2 seam only.
  return bucket as unknown as R2Bucket;
};

const authorityDriftArtifactBucketStub = (
  calls: Array<string>,
  contentId: ContentId,
  afterAttemptDiscovery: () => void,
) => {
  const contentKey = contentKeyFor(contentId);
  const bucket = {
    delete: (keys: string | Array<string>) => {
      calls.push(`delete:${Array.isArray(keys) ? keys.join(",") : keys}`);
      return Promise.resolve();
    },
    head: (key: string) => {
      calls.push(`head:${key}`);
      return Promise.resolve({
        customMetadata: { osfo: JSON.stringify({ userId: "user-1" }) },
        key,
      });
    },
    list: ({ prefix }: R2ListOptions) => {
      calls.push(`list:${prefix}`);
      if (prefix === documentAttemptPrefix) afterAttemptDiscovery();
      return Promise.resolve({
        delimitedPrefixes: [],
        objects:
          prefix === documentContentPrefix
            ? [{ customMetadata: { osfo: JSON.stringify({ userId: "user-1" }) }, key: contentKey }]
            : [],
        truncated: false as const,
      });
    },
  };
  // SAFETY: Account deletion uses only the head, list, and delete methods supplied above.
  // oxlint-disable-next-line osfo/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The fake intentionally implements this test's narrow R2 seam only.
  return bucket as unknown as R2Bucket;
};

const authorityDriftFilesBucketStub = (
  calls: Array<string>,
  userId: UserId,
  afterDiscovery: () => void,
) => {
  const bucket = {
    delete: () => {
      calls.push("delete");
      return Promise.resolve();
    },
    list: () => {
      calls.push("list");
      afterDiscovery();
      return Promise.resolve({
        delimitedPrefixes: [],
        objects: [{ key: `users/${userId}/target` }],
        truncated: false as const,
      });
    },
  };
  // SAFETY: Account deletion uses only the list and delete methods supplied above.
  // oxlint-disable-next-line osfo/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The fake intentionally implements this test's narrow R2 seam only.
  return bucket as unknown as R2Bucket;
};
