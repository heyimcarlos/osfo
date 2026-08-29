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
  return {
    bucket: {
      get: (key: string) => {
        const value = objects.get(key);
        return Promise.resolve(value === undefined ? null : { text: () => Promise.resolve(value) });
      },
      put: (key: string, value: string) => {
        if (objects.has(key)) return Promise.resolve(null);
        objects.set(key, value);
        return Promise.resolve({ etag: `etag-${key}` });
      },
    } satisfies QualificationExecutionBucket,
    objects,
  };
};

it.effect("retains immutable qualification execution artifacts and reconciles exact retries", () =>
  Effect.gen(function* () {
    const { bucket } = bucketStub();
    const store = makeQualificationExecutionArtifactStore(bucket);

    yield* store.writeImmutable("qualification/run.json", "first");
    yield* store.writeImmutable("qualification/run.json", "first");

    const retained = yield* store.read("qualification/run.json");
    const conflict = yield* Effect.flip(
      store.writeImmutable("qualification/run.json", "different"),
    );
    expect(retained).toBe("first");
    expect(conflict).toBeInstanceOf(QualificationExecutionArtifactUnavailable);
  }),
);
