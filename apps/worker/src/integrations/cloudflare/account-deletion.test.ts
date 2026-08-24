/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import { make } from "./account-deletion";

it.effect("removes an interrupted document attempt without a retained artifact", () => {
  const deleted: Array<string> = [];
  const userId = UserId.make("user-1");
  const files = bucketStub({ deleted });
  const artifacts = bucketStub({
    deleted,
    objectsByPrefix: {
      "document-attempts/": [
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
    .remove(userId)
    .pipe(
      Effect.andThen(
        Effect.sync(() => {
          expect(deleted).toContain("document-attempts/orphaned-content");
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
