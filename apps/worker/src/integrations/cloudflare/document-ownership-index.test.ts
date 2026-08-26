import { expect, it } from "@effect/vitest";
import { Result } from "effect";

import { UserId } from "../../domain";
import { ContentId } from "../../domain/client-content";
import { DocumentOwnershipIndex } from "./document-ownership-index";
import { ownerKeyFor } from "./document-storage-keys";

/* oxlint-disable effecttsgo/async-function -- These tests exercise the Promise-based R2 adapter boundary. */

it("creates and idempotently verifies one exact User-scoped ownership marker", async () => {
  const objects = new Map<string, Partial<R2Object>>();
  const userId = UserId.make("user-1");
  const contentId = ContentId.make("content-1");
  const bucket = bucketStub(objects);

  await DocumentOwnershipIndex.ensure(bucket, userId, contentId);
  await DocumentOwnershipIndex.ensure(bucket, userId, contentId);

  const stored = objects.get(ownerKeyFor(userId, contentId));
  expect(stored).toBeDefined();
  if (stored === undefined) throw new Error("Ownership marker missing");
  expect(Result.isSuccess(DocumentOwnershipIndex.decode(stored))).toBe(true);
});

it("rejects an existing malformed marker instead of overwriting ownership", async () => {
  const userId = UserId.make("user-1");
  const contentId = ContentId.make("content-1");
  const key = ownerKeyFor(userId, contentId);
  const objects = new Map<string, Partial<R2Object>>([
    [key, { customMetadata: { osfo: "not-json" }, etag: "existing", key }],
  ]);

  await expect(
    DocumentOwnershipIndex.ensure(bucketStub(objects), userId, contentId),
  ).rejects.toThrow("Generated-document ownership marker is invalid");
});

const bucketStub = (objects: Map<string, Partial<R2Object>>) => {
  const bucket = {
    head: (key: string) => Promise.resolve(objects.get(key) ?? null),
    put: (key: string, _body: Uint8Array, options: R2PutOptions) => {
      if (objects.has(key) && options.onlyIf !== undefined) return Promise.resolve(null);
      const object =
        options.customMetadata === undefined
          ? { etag: "created", key }
          : { customMetadata: options.customMetadata, etag: "created", key };
      objects.set(key, object);
      return Promise.resolve(object);
    },
  };
  // SAFETY: The ownership-index contract uses only the head and put methods supplied above.
  // oxlint-disable-next-line osfo/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The fake intentionally implements this test's narrow R2 seam only.
  return bucket as unknown as R2Bucket;
};
