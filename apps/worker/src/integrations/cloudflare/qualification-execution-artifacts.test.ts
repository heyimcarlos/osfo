/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect Vitest generators. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  makeQualificationExecutionArtifactStore,
  QualificationExecutionArtifactUnavailable,
  type QualificationExecutionBucket,
} from "./qualification-execution-artifacts";

const bucketStub = () => {
  const objects = new Map<string, string>();
  const writes: Array<{
    readonly key: string;
    readonly options: Parameters<QualificationExecutionBucket["put"]>[2];
  }> = [];
  return {
    bucket: {
      get: (key: string) => {
        const value = objects.get(key);
        return Promise.resolve(value === undefined ? null : { text: () => Promise.resolve(value) });
      },
      put: (
        key: string,
        value: string,
        options: Parameters<QualificationExecutionBucket["put"]>[2],
      ) => {
        writes.push({ key, options });
        if (objects.has(key)) return Promise.resolve(null);
        objects.set(key, value);
        return Promise.resolve({ etag: `etag-${key}` });
      },
    } satisfies QualificationExecutionBucket,
    objects,
    writes,
  };
};

it.effect("retains immutable qualification execution artifacts and reconciles exact retries", () =>
  Effect.gen(function* () {
    const { bucket, writes } = bucketStub();
    const store = makeQualificationExecutionArtifactStore(bucket);

    yield* store.writeImmutable("qualification/run.json", "first");
    yield* store.writeImmutable("qualification/run.json", "first");

    const retained = yield* store.read("qualification/run.json");
    const conflict = yield* Effect.flip(
      store.writeImmutable("qualification/run.json", "different"),
    );
    expect(retained).toBe("first");
    expect(conflict).toBeInstanceOf(QualificationExecutionArtifactUnavailable);
    expect(writes).toHaveLength(3);
    expect(writes.every(({ options }) => options.onlyIf.etagDoesNotMatch === "*")).toBe(true);
    expect(writes[0]?.options).toEqual({
      customMetadata: { "osfo-kind": "qualification-execution-v1" },
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    });
  }),
);
