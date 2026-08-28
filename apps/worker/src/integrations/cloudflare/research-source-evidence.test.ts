/* oxlint-disable vitest/no-standalone-expect, effecttsgo/global-date -- Assertions execute inside Effects and fixed dates are immutable evidence. */
import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { UserId } from "../../domain";
import { ResearchCollector } from "../../services/research-collector";
import { ResearchReport } from "../../services/research-report";
import { make } from "./research-source-evidence";

const userId = UserId.make("source-owner");
const workflowId = ResearchReport.WorkflowId.make("source-workflow");
const operationId = ResearchCollector.OperationId.make(`${workflowId}:provider:1`);

it.effect(
  "stores exact source and manifest evidence immutably under the User deletion prefix",
  () => {
    const fake = makeBucket();
    const evidence = make(fake.bucket);
    const input = {
      content: "source body",
      contentDigest: ResearchReport.InputDigest.make(
        "8e0217a3ecb3eea361aa1807153c7ad853ff9e4d3e107a2d8be40ad66ceb2dc6",
      ),
      contentType: "text/plain",
      fetchedAt: new Date("2026-08-27T12:05:00.000Z"),
      finalUrl: "https://example.com/source",
      operationId,
      title: "Source",
      userId,
    };
    return Effect.gen(function* () {
      const first = yield* evidence.put(input);
      const replayed = yield* evidence.put(input);
      const reconciled = yield* evidence.reconcile(userId, operationId);
      expect(first).toEqual(replayed);
      expect(reconciled).toEqual(first);
      expect(first.contentKey).toMatch(
        new RegExp(`^users/${userId}/research-report/sources/`, "u"),
      );

      const manifestSource = {
        contentDigest: first.contentDigest,
        contentKey: first.contentKey,
        fetchedAt: first.fetchedAt,
        sourceId: `${workflowId}:source:0`,
        title: first.title,
        url: first.finalUrl,
      };
      const manifest = ResearchCollector.SourceManifest.make({
        sources: [manifestSource],
        version: "research-source-manifest-v1",
        workflowId,
      });
      const retainedManifest = yield* evidence.putManifest(userId, manifest);
      expect(retainedManifest.manifestKey).toMatch(
        new RegExp(`^users/${userId}/research-report/manifests/`, "u"),
      );
      expect(
        yield* evidence.readManifest(
          userId,
          retainedManifest.manifestKey,
          retainedManifest.manifestDigest,
        ),
      ).toEqual(manifest);
      yield* evidence.putManifest(userId, manifest);

      const changed = yield* evidence
        .putManifest(userId, {
          ...manifest,
          sources: [
            {
              ...manifestSource,
              url: "https://example.com/changed",
            },
          ],
        })
        .pipe(Effect.result);
      expect(Result.isFailure(changed)).toBe(true);
      if (Result.isFailure(changed)) {
        expect(changed.failure).toMatchObject({
          _tag: "ResearchCollectorUnavailable",
          reason: "storageUnavailable",
        });
      }
      expect(fake.objects.size).toBe(2);
      yield* evidence.removePage(userId, first.contentKey);
      yield* evidence.removeManifest(userId, workflowId);
      expect(fake.objects.size).toBe(0);
    });
  },
);

const makeBucket = () => {
  const objects = new Map<string, string>();
  const boundary = {
    delete: (key: string) => {
      objects.delete(key);
      return Promise.resolve();
    },
    get: (key: string) => {
      const body = objects.get(key);
      return Promise.resolve(body === undefined ? null : object(key, body));
    },
    put: (key: string, value: string) => {
      if (objects.has(key)) return Promise.resolve(null);
      objects.set(key, value);
      return Promise.resolve(object(key, value));
    },
  };
  // SAFETY: This fake implements only get/put, the two R2 methods owned by this adapter test.
  // oxlint-disable-next-line osfo/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Narrow boundary fake.
  const bucket = boundary as unknown as R2Bucket;
  return { bucket, objects };
};

const object = (key: string, body: string) => ({ key, text: () => Promise.resolve(body) });
