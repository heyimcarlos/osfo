import { Effect, Schema } from "effect";

import { UserId } from "../../domain";
import { ResearchReport } from "../../services/research-report";
import { ResearchSynthesis } from "../../services/research-synthesis";

/* oxlint-disable effecttsgo/async-function -- Cloudflare R2 exposes Promise-only bodies. */

const Envelope = Schema.Struct({
  companyCost: ResearchSynthesis.CompanyCost,
  operationId: ResearchSynthesis.OperationId,
  result: ResearchSynthesis.Result,
  resultDigest: ResearchReport.InputDigest,
  userId: UserId,
  version: Schema.Literal("research-synthesis-evidence-v1"),
});
type Envelope = typeof Envelope.Type;

const EncodedEnvelope = Schema.fromJsonString(
  Schema.Struct({
    companyCost: Schema.Struct({
      basis: Schema.Literals(["conservative", "observed"]),
      inputTokens: Schema.BigIntFromString,
      outputTokens: Schema.BigIntFromString,
      providerOperationId: Schema.String,
      usdMicros: Schema.BigIntFromString,
    }),
    operationId: ResearchSynthesis.OperationId,
    result: ResearchSynthesis.Result,
    resultDigest: ResearchReport.InputDigest,
    userId: UserId,
    version: Schema.Literal("research-synthesis-evidence-v1"),
  }),
);

/** Immutable private structured synthesis evidence stored beneath the User prefix. */
export const make = (bucket: R2Bucket): ResearchSynthesis.PortInterface["evidence"] => ({
  delete: (userId, resultKey) =>
    validateKey(userId, resultKey).pipe(
      Effect.andThen(request("delete", () => bucket.delete(resultKey))),
    ),
  put: (userId, operationId, result, companyCost) =>
    Effect.gen(function* () {
      const resultDigest = yield* digestResult(result);
      const envelope = Envelope.make({
        companyCost,
        operationId,
        result,
        resultDigest,
        userId,
        version: "research-synthesis-evidence-v1",
      });
      const encoded = yield* encode(envelope);
      const resultKey = keyFor(userId, operationId);
      const created = yield* request("put", () =>
        bucket.put(resultKey, encoded, {
          customMetadata: {
            "osfo-kind": "research-synthesis-evidence-v1",
            "osfo-operation-id": operationId,
          },
          onlyIf: { etagDoesNotMatch: "*" },
        }),
      );
      if (created !== null) return { resultDigest, resultKey };
      const retained = yield* readEnvelope(bucket, resultKey);
      if (retained === null || (yield* encode(retained)) !== encoded) {
        return yield* unavailable(
          "The immutable synthesis identity already contains different facts",
        );
      }
      return { resultDigest: retained.resultDigest, resultKey };
    }),
  read: (userId, resultKey, resultDigest) =>
    Effect.gen(function* () {
      yield* validateKey(userId, resultKey);
      const retained = yield* readEnvelope(bucket, resultKey);
      if (
        retained === null ||
        retained.userId !== userId ||
        retained.resultDigest !== resultDigest ||
        (yield* digestResult(retained.result)) !== resultDigest
      ) {
        return yield* unavailable("The retained synthesis does not match its immutable digest");
      }
      return retained.result;
    }),
  reconcile: (userId, operationId) =>
    Effect.gen(function* () {
      const resultKey = keyFor(userId, operationId);
      const retained = yield* readEnvelope(bucket, resultKey);
      if (retained === null) return null;
      if (
        retained.userId !== userId ||
        retained.operationId !== operationId ||
        (yield* digestResult(retained.result)) !== retained.resultDigest
      ) {
        return yield* unavailable("The retained synthesis cannot reconcile this operation");
      }
      return {
        companyCost: retained.companyCost,
        result: retained.result,
        resultDigest: retained.resultDigest,
        resultKey,
      };
    }),
});

const readEnvelope = (bucket: R2Bucket, key: string) =>
  request("get", () => bucket.get(key)).pipe(
    Effect.flatMap((object) =>
      object === null
        ? Effect.succeed(null)
        : request("readBody", () => object.text()).pipe(
            Effect.flatMap((encoded) =>
              Schema.decodeEffect(EncodedEnvelope)(encoded).pipe(
                Effect.mapError((cause) =>
                  unavailable("Retained synthesis evidence is invalid", cause),
                ),
              ),
            ),
          ),
    ),
  );

const encode = (envelope: Envelope) =>
  Schema.encodeEffect(EncodedEnvelope)(envelope).pipe(
    Effect.mapError((cause) => unavailable("Synthesis evidence cannot be encoded", cause)),
  );

const digestResult = (result: ResearchSynthesis.Result) =>
  Schema.encodeEffect(Schema.fromJsonString(ResearchSynthesis.Result))(result).pipe(
    Effect.mapError((cause) => unavailable("Synthesis result cannot be encoded", cause)),
    Effect.flatMap((encoded) =>
      Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded))),
    ),
    Effect.map((bytes) =>
      ResearchReport.InputDigest.make(
        Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
    ),
  );

const validateKey = (userId: UserId, key: string) =>
  key.startsWith(`users/${encodeURIComponent(userId)}/research-report/syntheses/`)
    ? Effect.void
    : Effect.fail(unavailable("The synthesis-evidence key is not User-owned"));

const keyFor = (userId: UserId, operationId: ResearchSynthesis.OperationId) =>
  `users/${encodeURIComponent(userId)}/research-report/syntheses/${encodeURIComponent(operationId)}.json`;

const request = <Value>(operation: string, perform: () => Promise<Value>) =>
  Effect.tryPromise({
    try: perform,
    catch: (cause) => unavailable(`Cloudflare R2 could not ${operation} synthesis evidence`, cause),
  });

const unavailable = (message: string, cause: unknown = message) =>
  new ResearchSynthesis.Unavailable({ cause, message, reason: "storageUnavailable" });

export * as ResearchSynthesisEvidence from "./research-synthesis-evidence";
