/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-date-in-effect, eslint/no-underscore-dangle, vitest/no-standalone-expect -- Runtime R2 fakes and fixed time make attempt transitions deterministic. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import { ContentId } from "../../domain/client-content";
import { DocumentIntentDigest } from "../../services/document-generation";
import {
  makeAttemptEvidenceStore,
  settleAttemptEvidenceForTerminalCleanup,
} from "./document-compute";
import { DocumentOwnershipIndex } from "./document-ownership-index";
import { attemptKeyFor, ownerKeyFor } from "./document-storage-keys";

const contentId = ContentId.make("document:workflow:cleanup-test");
const userId = UserId.make("cleanup-user");
const intentDigest = DocumentIntentDigest.make("a".repeat(64));
const cost = {
  _tag: "Incurred" as const,
  allowancePeriodId: AllowancePeriodId.make("cleanup-period"),
  basis: "conservative" as const,
  providerOperationId: "cleanup-provider-operation",
  usdMicros: 50_000n,
};

it.effect("preserves started incurred evidence and its ownership marker", () => {
  const fixture = bucketFixture();
  const store = makeAttemptEvidenceStore(fixture.bucket);
  return Effect.gen(function* () {
    const claimed = yield* Effect.promise(() =>
      store.claim(contentId, intentDigest, cost, Date.now() + 60_000, userId),
    );
    if (claimed._tag !== "Claimed") throw new Error("Expected claimed attempt evidence");
    const started = { ...claimed.evidence, status: "started" as const };
    yield* Effect.promise(() => store.start(contentId, started, claimed.revision));

    expect(yield* settleAttemptEvidenceForTerminalCleanup(fixture.bucket, contentId, userId)).toBe(
      "preserved",
    );
    expect(fixture.objects.has(attemptKeyFor(contentId))).toBe(true);
    expect(fixture.objects.has(ownerKeyFor(userId, contentId))).toBe(true);
  });
});

it.effect("preserves completed incurred evidence and its ownership marker", () => {
  const fixture = bucketFixture();
  const store = makeAttemptEvidenceStore(fixture.bucket);
  return Effect.gen(function* () {
    const claimed = yield* Effect.promise(() =>
      store.claim(contentId, intentDigest, cost, Date.now() + 60_000, userId),
    );
    if (claimed._tag !== "Claimed") throw new Error("Expected claimed attempt evidence");
    const started = { ...claimed.evidence, status: "started" as const };
    const startedRevision = yield* Effect.promise(() =>
      store.start(contentId, started, claimed.revision),
    );
    if (startedRevision === null) throw new Error("Expected started attempt evidence");
    yield* Effect.promise(() =>
      store.complete(
        contentId,
        { ...started, renderedPageCount: 1, status: "completed" },
        startedRevision,
      ),
    );

    expect(yield* settleAttemptEvidenceForTerminalCleanup(fixture.bucket, contentId, userId)).toBe(
      "preserved",
    );
    expect(fixture.objects.has(attemptKeyFor(contentId))).toBe(true);
    expect(fixture.objects.has(ownerKeyFor(userId, contentId))).toBe(true);
  });
});

it.effect("removes claimed no-use evidence and its ownership marker", () => {
  const fixture = bucketFixture();
  const store = makeAttemptEvidenceStore(fixture.bucket);
  return Effect.gen(function* () {
    yield* Effect.promise(() =>
      store.claim(contentId, intentDigest, cost, Date.now() + 60_000, userId),
    );

    expect(yield* settleAttemptEvidenceForTerminalCleanup(fixture.bucket, contentId, userId)).toBe(
      "discarded",
    );
    expect(fixture.objects.has(attemptKeyFor(contentId))).toBe(false);
    expect(fixture.objects.has(ownerKeyFor(userId, contentId))).toBe(false);
  });
});

it.effect("removes an orphan ownership marker created before an attempt claim", () => {
  const fixture = bucketFixture();
  return Effect.gen(function* () {
    yield* Effect.promise(() => DocumentOwnershipIndex.ensure(fixture.bucket, userId, contentId));

    expect(yield* settleAttemptEvidenceForTerminalCleanup(fixture.bucket, contentId, userId)).toBe(
      "discarded",
    );
    expect(fixture.objects.has(ownerKeyFor(userId, contentId))).toBe(false);
  });
});

const bucketFixture = () => {
  const objects = new Map<string, Partial<R2Object>>();
  let revision = 0;
  const bucket = {
    delete: (keys: string | Array<string>) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      return Promise.resolve();
    },
    head: (key: string) => Promise.resolve(objects.get(key) ?? null),
    put: (key: string, _body: Uint8Array, options: R2PutOptions) => {
      const existing = objects.get(key);
      if (options.onlyIf !== undefined) {
        if ("etagDoesNotMatch" in options.onlyIf && existing !== undefined) {
          return Promise.resolve(null);
        }
        if ("etagMatches" in options.onlyIf && existing?.etag !== options.onlyIf.etagMatches) {
          return Promise.resolve(null);
        }
      }
      revision += 1;
      const object: Partial<R2Object> =
        options.customMetadata === undefined
          ? { etag: `revision-${revision}`, key }
          : { customMetadata: options.customMetadata, etag: `revision-${revision}`, key };
      objects.set(key, object);
      return Promise.resolve(object);
    },
  };
  // SAFETY: This fake implements only the R2 methods exercised by attempt cleanup.
  // oxlint-disable-next-line osfo/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Narrow external test seam.
  return { bucket: bucket as unknown as R2Bucket, objects };
};
