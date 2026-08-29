import { Data, Effect } from "effect";

import type { QualificationExecutionArtifactStore } from "../../qualification/execution";

export class QualificationExecutionArtifactUnavailable extends Data.TaggedError(
  "QualificationExecutionArtifactUnavailable",
)<{ readonly cause?: unknown; readonly message: string }> {}

const unavailable = (message: string, cause?: unknown) =>
  new QualificationExecutionArtifactUnavailable({ cause, message });

const request = <A>(operation: string, attempt: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => unavailable(`R2 qualification ${operation} failed`, cause),
    try: attempt,
  });

export interface QualificationExecutionBucket {
  readonly get: (key: string) => Promise<{ readonly text: () => Promise<string> } | null>;
  readonly put: (
    key: string,
    value: string,
    options: {
      readonly customMetadata: Readonly<Record<string, string>>;
      readonly httpMetadata: { readonly contentType: string };
      readonly onlyIf: { readonly etagDoesNotMatch: string };
    },
  ) => Promise<{ readonly etag: string } | null>;
}

/** Immutable R2 store for content-addressed qualification execution artifacts. */
export const makeQualificationExecutionArtifactStore = (
  bucket: QualificationExecutionBucket,
): QualificationExecutionArtifactStore<QualificationExecutionArtifactUnavailable> => ({
  read: (artifactId) =>
    request("read", () => bucket.get(artifactId)).pipe(
      Effect.flatMap((object) =>
        object === null ? Effect.succeed(null) : request("read body", () => object.text()),
      ),
    ),
  writeImmutable: (artifactId, encoded) =>
    Effect.gen(function* () {
      const created = yield* request("write", () =>
        bucket.put(artifactId, encoded, {
          customMetadata: { "osfo-kind": "qualification-execution-v1" },
          httpMetadata: { contentType: "application/json" },
          onlyIf: { etagDoesNotMatch: "*" },
        }),
      );
      if (created === null) {
        const retained = yield* request("reconcile", () => bucket.get(artifactId));
        if (retained === null) {
          return yield* unavailable(
            "Immutable qualification artifact vanished during reconciliation",
          );
        }
        const retainedEncoded = yield* request("read reconciled body", () => retained.text());
        if (retainedEncoded !== encoded) {
          return yield* unavailable(
            "Immutable qualification artifact identity already contains different content",
          );
        }
      }
      return undefined;
    }),
});
