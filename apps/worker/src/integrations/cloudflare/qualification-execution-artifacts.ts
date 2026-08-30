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
  readonly get: (key: string) => Promise<{
    readonly customMetadata?: Readonly<Record<string, string>>;
    readonly httpMetadata?: { readonly contentType?: string };
    readonly text: () => Promise<string>;
  } | null>;
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

/** R2 metadata surfaced by paginated qualification authority-stream listings. */
export interface QualificationExecutionListedObject {
  readonly checksums: { readonly sha256?: ArrayBuffer | ArrayBufferView | undefined };
  readonly customMetadata?: Readonly<Record<string, string>> | undefined;
  readonly key: string;
}

/** R2 listing boundary used to prove a retained authority stream without loading its bodies. */
export interface QualificationExecutionListingBucket extends QualificationExecutionBucket {
  readonly list: (options: {
    readonly cursor?: string | undefined;
    readonly include: readonly ["customMetadata"];
    readonly limit: number;
    readonly prefix: string;
  }) => Promise<
    | {
        readonly objects: ReadonlyArray<QualificationExecutionListedObject>;
        readonly truncated: false;
      }
    | {
        readonly cursor: string;
        readonly objects: ReadonlyArray<QualificationExecutionListedObject>;
        readonly truncated: true;
      }
  >;
}

/** Adapt the generated R2 binding to the exact metadata-only qualification surface. */
export const qualificationExecutionListingBucket = (
  bucket: Pick<R2Bucket, "get" | "list" | "put">,
): QualificationExecutionListingBucket => ({
  get: (key) => bucket.get(key),
  list: (options) => {
    const r2Options: R2ListOptions =
      options.cursor === undefined
        ? { include: ["customMetadata"], limit: options.limit, prefix: options.prefix }
        : {
            cursor: options.cursor,
            include: ["customMetadata"],
            limit: options.limit,
            prefix: options.prefix,
          };
    return bucket.list(r2Options);
  },
  put: (key, value, options) => bucket.put(key, value, options),
});

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
