import { Effect, Schema } from "effect";

import { UserId } from "../../domain";
import { ResearchCollector } from "../../services/research-collector";
import { ResearchReport } from "../../services/research-report";

/* oxlint-disable effecttsgo/async-function -- Cloudflare R2 exposes Promise-only object boundaries. */

const Envelope = Schema.Struct({
  content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256_000)),
  contentDigest: ResearchReport.InputDigest,
  contentType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  fetchedAt: Schema.DateFromString,
  finalUrl: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  operationId: ResearchCollector.OperationId,
  title: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  userId: UserId,
  version: Schema.Literal("research-source-evidence-v1"),
});
type Envelope = typeof Envelope.Type;

const EncodedEnvelope = Schema.fromJsonString(Envelope);
const EncodedManifest = Schema.fromJsonString(ResearchCollector.SourceManifest);

/** Store fetched source bodies in immutable, User-owned R2 objects. */
export const make = (bucket: R2Bucket): ResearchCollector.PortInterface["sourceEvidence"] => ({
  readManifest: (userId, key, manifestDigest) =>
    Effect.gen(function* () {
      const prefix = `users/${encodeURIComponent(userId)}/research-report/manifests/`;
      if (!key.startsWith(prefix)) {
        return yield* unavailable("readManifest", "The source-manifest key is not User-owned");
      }
      const encoded = yield* readText(bucket, key);
      if (encoded === null) {
        return yield* unavailable("readManifest", "The committed source manifest is missing");
      }
      const retainedDigest = yield* digest(encoded);
      if (retainedDigest !== manifestDigest) {
        return yield* unavailable("readManifest", "The source manifest digest does not match");
      }
      return yield* Schema.decodeEffect(EncodedManifest)(encoded).pipe(
        Effect.mapError((cause) =>
          unavailable("readManifest", "The committed source manifest is invalid", cause),
        ),
      );
    }),
  readPage: (userId, page) =>
    Effect.gen(function* () {
      const prefix = `users/${encodeURIComponent(userId)}/research-report/sources/`;
      if (!page.contentKey.startsWith(prefix)) {
        return yield* unavailable("readPage", "The source-evidence key is not User-owned");
      }
      const retained = yield* read(bucket, page.contentKey);
      if (
        retained === null ||
        retained.userId !== userId ||
        retained.contentDigest !== page.contentDigest ||
        retained.finalUrl !== page.finalUrl
      ) {
        return yield* unavailable(
          "readPage",
          "The retained source body does not match its immutable page reference",
        );
      }
      return retained.content;
    }),
  removeManifest: (userId, workflowId) =>
    request("removeManifest", () => bucket.delete(manifestKey(userId, workflowId))),
  removePage: (userId, contentKey) => {
    const prefix = `users/${encodeURIComponent(userId)}/research-report/sources/`;
    if (!contentKey.startsWith(prefix)) {
      return Effect.fail(
        unavailable("removePage", "The source-evidence key is not owned by the expected User"),
      );
    }
    return request("removePage", () => bucket.delete(contentKey));
  },
  putManifest: (userId, manifest) =>
    Effect.gen(function* () {
      if (manifest.workflowId.length === 0) {
        return yield* unavailable("putManifest", "The source manifest has no Workflow identity");
      }
      const key = manifestKey(userId, manifest.workflowId);
      const encoded = yield* Schema.encodeEffect(EncodedManifest)(manifest).pipe(
        Effect.mapError((cause) =>
          unavailable("putManifest", "The source manifest cannot be encoded", cause),
        ),
      );
      const manifestDigest = yield* digest(encoded);
      const created = yield* request("putManifest", () =>
        bucket.put(key, encoded, {
          customMetadata: {
            "osfo-kind": "research-source-manifest-v1",
            "osfo-workflow-id": manifest.workflowId,
          },
          onlyIf: { etagDoesNotMatch: "*" },
        }),
      );
      if (created !== null) return { manifestDigest, manifestKey: key };
      const retained = yield* readText(bucket, key);
      if (retained === null) {
        return yield* unavailable(
          "putManifest",
          "The immutable source-manifest identity vanished during reconciliation",
        );
      }
      const decoded = yield* Schema.decodeEffect(EncodedManifest)(retained).pipe(
        Effect.mapError((cause) =>
          unavailable("putManifest", "Retained source manifest is invalid", cause),
        ),
      );
      const retainedEncoded = yield* Schema.encodeEffect(EncodedManifest)(decoded).pipe(
        Effect.mapError((cause) =>
          unavailable("putManifest", "The retained source manifest cannot be encoded", cause),
        ),
      );
      if (retainedEncoded !== encoded) {
        return yield* unavailable(
          "putManifest",
          "The immutable source-manifest identity already contains different facts",
        );
      }
      return { manifestDigest, manifestKey: key };
    }),
  put: (input) =>
    Effect.gen(function* () {
      const key = sourceKey(input.userId, input.operationId);
      const envelope = Envelope.make({
        ...input,
        version: "research-source-evidence-v1",
      });
      const encoded = yield* Schema.encodeEffect(EncodedEnvelope)(envelope).pipe(
        Effect.mapError((cause) =>
          unavailable("put", "The source evidence cannot be encoded", cause),
        ),
      );
      const created = yield* request("put", () =>
        bucket.put(key, encoded, {
          customMetadata: {
            "osfo-kind": "research-source-evidence-v1",
            "osfo-operation-id": input.operationId,
          },
          onlyIf: { etagDoesNotMatch: "*" },
        }),
      );
      if (created !== null) return toPageResult(key, envelope);
      const retained = yield* read(bucket, key);
      if (retained === null || !sameEvidence(envelope, retained)) {
        return yield* unavailable(
          "put",
          "The immutable source-evidence identity already contains different facts",
        );
      }
      return toPageResult(key, retained);
    }),
  reconcile: (userId, operationId) =>
    Effect.gen(function* () {
      const key = sourceKey(userId, operationId);
      const retained = yield* read(bucket, key);
      if (retained === null) return null;
      if (retained.userId !== userId || retained.operationId !== operationId) {
        return yield* unavailable(
          "reconcile",
          "The retained source evidence does not own the requested operation identity",
        );
      }
      return toPageResult(key, retained);
    }),
});

const read = (bucket: R2Bucket, key: string) =>
  readText(bucket, key).pipe(
    Effect.flatMap((encoded) => {
      if (encoded === null) return Effect.succeed(null);
      return Schema.decodeEffect(EncodedEnvelope)(encoded).pipe(
        Effect.mapError((cause) =>
          unavailable("decode", "Retained source evidence is invalid", cause),
        ),
        Effect.flatMap((envelope) =>
          digest(envelope.content).pipe(
            Effect.flatMap((contentDigest) =>
              contentDigest === envelope.contentDigest
                ? Effect.succeed(envelope)
                : Effect.fail(
                    unavailable(
                      "verify",
                      "Retained source evidence does not match its content digest",
                    ),
                  ),
            ),
          ),
        ),
      );
    }),
  );

const readText = (bucket: R2Bucket, key: string) =>
  request("get", () => bucket.get(key)).pipe(
    Effect.flatMap((object) =>
      object === null ? Effect.succeed(null) : request("readBody", () => object.text()),
    ),
  );

const toPageResult = (
  key: string,
  envelope: Envelope,
): Extract<ResearchCollector.OperationResult, { readonly _tag: "Page" }> => ({
  _tag: "Page",
  contentDigest: envelope.contentDigest,
  contentKey: key,
  contentType: envelope.contentType,
  fetchedAt: envelope.fetchedAt,
  finalUrl: envelope.finalUrl,
  title: envelope.title,
});

const sameEvidence = (left: Envelope, right: Envelope) =>
  left.content === right.content &&
  left.contentDigest === right.contentDigest &&
  left.contentType === right.contentType &&
  left.fetchedAt.getTime() === right.fetchedAt.getTime() &&
  left.finalUrl === right.finalUrl &&
  left.operationId === right.operationId &&
  left.title === right.title &&
  left.userId === right.userId;

const sourceKey = (userId: UserId, operationId: ResearchCollector.OperationId) =>
  `users/${encodeURIComponent(userId)}/research-report/sources/${encodeURIComponent(operationId)}.json`;

const manifestKey = (userId: UserId, workflowId: ResearchReport.WorkflowId) =>
  `users/${encodeURIComponent(userId)}/research-report/manifests/${encodeURIComponent(workflowId)}.json`;

const digest = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map((bytes) =>
      ResearchReport.InputDigest.make(
        Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
    ),
  );

const request = <Value>(operation: string, perform: () => Promise<Value>) =>
  Effect.tryPromise({
    try: perform,
    catch: (cause) => unavailable(operation, "Cloudflare R2 source evidence is unavailable", cause),
  });

const unavailable = (operation: string, message: string, cause: unknown = operation) =>
  new ResearchCollector.Unavailable({
    cause,
    message,
    reason: "storageUnavailable",
  });

export * as ResearchSourceEvidence from "./research-source-evidence";
