import { Context, DateTime, Effect, Layer, Predicate, Schema } from "effect";

import type { ManagedModelRoute } from "../domain/model-access-policy";
import type { ModelAccessPolicyVersion, ResourcePriceVersion } from "../domain";
import type { Denied } from "./authorization";
import type { ResearchCollector } from "./research-collector";
import { ResearchReport } from "./research-report";

/* oxlint-disable eslint/no-underscore-dangle -- Durable outcomes use Effect's conventional tag. */

const bounded = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const synthesisAttemptLeaseMilliseconds = 35_000;

export const EvidenceQuote = Schema.Struct({
  quote: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(2_000)),
  sourceId: bounded(300),
});

export const MaterialClaim = Schema.Struct({
  evidence: Schema.Array(EvidenceQuote).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  statement: bounded(2_000),
});
export type MaterialClaim = typeof MaterialClaim.Type;

export const Section = Schema.Struct({
  heading: bounded(200),
  materialClaims: Schema.Array(MaterialClaim).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
});

/** Structured model result whose every material statement carries retained evidence. */
export const Result = Schema.Struct({
  conclusion: Schema.Array(MaterialClaim).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  sections: Schema.Array(Section).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  summary: Schema.Array(MaterialClaim).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  title: bounded(200),
});
export type Result = typeof Result.Type;

export const OperationId = bounded(300).pipe(Schema.brand("ResearchSynthesisOperationId"));
export type OperationId = typeof OperationId.Type;

export const CompanyCost = Schema.Struct({
  basis: Schema.Literals(["conservative", "observed"]),
  inputTokens: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  outputTokens: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  providerOperationId: bounded(500),
  usdMicros: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
});
export type CompanyCost = typeof CompanyCost.Type;

export const State = Schema.Literals(["pending", "completed", "unknown", "failed", "canceled"]);
export type State = typeof State.Type;

export interface Operation {
  readonly operationId: OperationId;
  readonly workflowId: ResearchReport.WorkflowId;
  readonly inputDigest: ResearchReport.InputDigest;
  readonly state: State;
  readonly modelRoute: ManagedModelRoute;
  readonly modelAccessPolicyVersion: ModelAccessPolicyVersion;
  readonly resourcePriceVersion: ResourcePriceVersion;
  readonly resultKey: string | null;
  readonly resultDigest: ResearchReport.InputDigest | null;
  readonly companyCost: CompanyCost | null;
  readonly safeFailureCode: string | null;
  readonly attemptCount: number;
  readonly startedAt: Date | null;
}

export interface Completed {
  readonly companyCost: CompanyCost;
  readonly operationId: OperationId;
  readonly result: Result;
  readonly resultDigest: ResearchReport.InputDigest;
  readonly resultKey: string;
}

export class Conflict extends Schema.TaggedError<Conflict>()("ResearchSynthesisConflict", {
  message: Schema.String,
  operationId: OperationId,
}) {}

export class Unavailable extends Schema.TaggedError<Unavailable>()("ResearchSynthesisUnavailable", {
  cause: Schema.Defect(),
  message: Schema.String,
  reason: Schema.Literals([
    "ambiguousOperation",
    "authorizationDenied",
    "fabricatedEvidence",
    "modelUnavailable",
    "storageUnavailable",
  ]),
}) {}

export interface PortInterface {
  readonly authorize: (
    report: ResearchReport.Record,
  ) => Effect.Effect<
    ResearchReport.Record,
    ResearchReport.Conflict | Denied | ResearchReport.NotFound | ResearchReport.Unavailable
  >;
  readonly evidence: {
    readonly delete: (
      userId: ResearchReport.Record["userId"],
      resultKey: string,
    ) => Effect.Effect<void, Unavailable>;
    readonly put: (
      userId: ResearchReport.Record["userId"],
      operationId: OperationId,
      result: Result,
      companyCost: CompanyCost,
    ) => Effect.Effect<
      { readonly resultDigest: ResearchReport.InputDigest; readonly resultKey: string },
      Unavailable
    >;
    readonly read: (
      userId: ResearchReport.Record["userId"],
      resultKey: string,
      resultDigest: ResearchReport.InputDigest,
    ) => Effect.Effect<Result, Unavailable>;
    readonly reconcile: (
      userId: ResearchReport.Record["userId"],
      operationId: OperationId,
    ) => Effect.Effect<
      {
        readonly companyCost: CompanyCost;
        readonly result: Result;
        readonly resultDigest: ResearchReport.InputDigest;
        readonly resultKey: string;
      } | null,
      Unavailable
    >;
  };
  readonly persistence: {
    readonly claim: (
      operation: Operation,
    ) => Effect.Effect<
      | { readonly _tag: "Created"; readonly operation: Operation }
      | { readonly _tag: "Existing"; readonly operation: Operation },
      Conflict | Unavailable
    >;
    readonly complete: (
      operation: Operation,
      retained: { readonly resultDigest: ResearchReport.InputDigest; readonly resultKey: string },
      companyCost: CompanyCost,
    ) => Effect.Effect<Operation, Conflict | Unavailable>;
    readonly finish: (
      operation: Operation,
      state: "canceled" | "failed" | "unknown",
      safeFailureCode: string,
      companyCost: CompanyCost,
    ) => Effect.Effect<Operation, Conflict | Unavailable>;
    readonly expireAmbiguous: (
      operation: Operation,
      expiredBefore: Date,
    ) => Effect.Effect<boolean, Unavailable>;
    readonly recordAttempt: (
      operationId: OperationId,
      expectedAttemptCount: number,
    ) => Effect.Effect<
      | { readonly _tag: "InFlight"; readonly operation: Operation }
      | { readonly _tag: "Started"; readonly operation: Operation },
      Unavailable
    >;
  };
  readonly provider: {
    readonly generate: (input: {
      readonly modelRoute: ManagedModelRoute;
      readonly operationId: OperationId;
      readonly sources: ReadonlyArray<ResearchCollector.RetainedSource>;
      readonly topic: string;
    }) => Effect.Effect<
      | { readonly _tag: "Completed"; readonly companyCost: CompanyCost; readonly result: unknown }
      | { readonly _tag: "Unknown"; readonly companyCost: CompanyCost }
    >;
  };
  readonly recordCompanyCost: (
    report: ResearchReport.Record,
    companyCost: CompanyCost,
  ) => Effect.Effect<void, Unavailable>;
}

export class Port extends Context.Service<Port, PortInterface>()("@osfo/ResearchSynthesis/Port") {}

export interface Interface {
  readonly synthesize: (
    report: ResearchReport.Record,
    sources: ReadonlyArray<ResearchCollector.RetainedSource>,
  ) => Effect.Effect<Completed, Conflict | Unavailable>;
}

export class Service extends Context.Service<Service, Interface>()("@osfo/ResearchSynthesis") {}

export const make = Effect.gen(function* () {
  const ports = yield* Port;

  const synthesize = Effect.fn("ResearchSynthesis.synthesize")(function* (
    report: ResearchReport.Record,
    sources: ReadonlyArray<ResearchCollector.RetainedSource>,
  ) {
    const operation = yield* makeOperation(report, sources);
    const claimed = yield* ports.persistence.claim(operation);
    if (claimed.operation.inputDigest !== operation.inputDigest) {
      return yield* new Conflict({
        message: "The synthesis operation identity was replayed with changed source facts",
        operationId: operation.operationId,
      });
    }
    if (claimed.operation.companyCost !== null) {
      yield* ports.recordCompanyCost(report, claimed.operation.companyCost);
    }
    if (claimed.operation.state === "completed") {
      return yield* readCompleted(ports, report, claimed.operation, sources);
    }
    if (
      claimed.operation.state === "failed" &&
      claimed.operation.safeFailureCode === "invalid-synthesis-output"
    ) {
      return yield* unavailable(
        "fabricatedEvidence",
        "The retained synthesis attempt produced invalid citation evidence",
      );
    }
    if (
      claimed._tag === "Existing" &&
      claimed.operation.attemptCount > 0 &&
      (claimed.operation.state === "pending" || claimed.operation.state === "unknown")
    ) {
      const reconciled = yield* ports.evidence.reconcile(report.userId, operation.operationId);
      if (reconciled !== null) {
        if (
          claimed.operation.companyCost !== null &&
          !sameCompanyCost(claimed.operation.companyCost, reconciled.companyCost)
        ) {
          return yield* new Conflict({
            message: "Late synthesis evidence owns changed Company Cost facts",
            operationId: operation.operationId,
          });
        }
        const validated = yield* validateSynthesis(reconciled.result, sources).pipe(
          Effect.tapError(() =>
            ports.persistence
              .finish(
                claimed.operation,
                "failed",
                "invalid-synthesis-output",
                reconciled.companyCost,
              )
              .pipe(Effect.andThen(ports.recordCompanyCost(report, reconciled.companyCost))),
          ),
        );
        const recovered = yield* ports.persistence.complete(
          claimed.operation,
          reconciled,
          reconciled.companyCost,
        );
        yield* ports.recordCompanyCost(report, reconciled.companyCost);
        return completedFrom(recovered, validated);
      }
    }
    if (claimed._tag === "Existing" && claimed.operation.state !== "pending") {
      return yield* unavailable(
        "ambiguousOperation",
        "A prior synthesis operation has no safely replayable result",
        claimed.operation.state,
      );
    }
    if (claimed._tag === "Existing" && claimed.operation.attemptCount > 0) {
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
      yield* ports.persistence.expireAmbiguous(
        claimed.operation,
        DateTime.toDateUtc(
          DateTime.subtract(DateTime.makeUnsafe(now), {
            milliseconds: synthesisAttemptLeaseMilliseconds,
          }),
        ),
      );
      return yield* unavailable(
        "ambiguousOperation",
        "A prior synthesis model call may have completed without durable evidence",
      );
    }

    yield* authorize(ports, report);
    const started = yield* ports.persistence.recordAttempt(
      operation.operationId,
      claimed.operation.attemptCount,
    );
    if (started._tag === "InFlight") {
      return yield* unavailable(
        "ambiguousOperation",
        "Another invocation owns the synthesis provider attempt",
      );
    }
    const generated = yield* ports.provider.generate({
      modelRoute: report.modelRoute,
      operationId: operation.operationId,
      sources: boundedPromptSources(sources),
      topic: report.request.topic,
    });
    if (Predicate.isTagged(generated, "Unknown")) {
      yield* ports.persistence.finish(
        started.operation,
        "unknown",
        "ambiguous-model-acceptance-company-cost",
        generated.companyCost,
      );
      yield* ports.recordCompanyCost(report, generated.companyCost);
      return yield* unavailable(
        "ambiguousOperation",
        "The synthesis model outcome is ambiguous and was not retried",
      );
    }
    const result = yield* validateSynthesis(generated.result, sources).pipe(
      Effect.tapError(() =>
        ports.persistence
          .finish(started.operation, "failed", "invalid-synthesis-output", generated.companyCost)
          .pipe(Effect.andThen(ports.recordCompanyCost(report, generated.companyCost))),
      ),
    );
    const retained = yield* ports.evidence.put(
      report.userId,
      operation.operationId,
      result,
      generated.companyCost,
    );
    const reauthorized = yield* authorize(ports, report).pipe(Effect.result);
    if (Predicate.isTagged(reauthorized, "Failure")) {
      yield* ports.persistence.finish(
        started.operation,
        "canceled",
        "authority-ended-after-synthesis",
        generated.companyCost,
      );
      const costRecorded = yield* ports
        .recordCompanyCost(report, generated.companyCost)
        .pipe(Effect.result);
      yield* ports.evidence.delete(report.userId, retained.resultKey);
      if (Predicate.isTagged(costRecorded, "Failure")) return yield* costRecorded.failure;
      return yield* reauthorized.failure;
    }
    const finished = yield* ports.persistence.complete(
      started.operation,
      retained,
      generated.companyCost,
    );
    yield* ports.recordCompanyCost(report, generated.companyCost);
    return completedFrom(finished, result);
  });

  return Service.of({ synthesize });
});

export const layerWithoutDependencies = Layer.effect(Service, make);

/** Deterministically bind every material claim to exact retained page evidence. */
export const validateSynthesis = (
  // oxlint-disable-next-line osfo/no-unknown-parameters -- This owning schema is the provider-output trust boundary.
  value: unknown,
  sources: ReadonlyArray<ResearchCollector.RetainedSource>,
): Effect.Effect<Result, Unavailable> =>
  Schema.decodeUnknownEffect(Result, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError((cause) =>
      unavailable("fabricatedEvidence", "The synthesis result is not a bounded report", cause),
    ),
    Effect.flatMap((result) => {
      const encodedBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
      const claims = [
        ...result.summary,
        ...result.sections.flatMap(({ materialClaims }) => materialClaims),
        ...result.conclusion,
      ];
      const unsafeText = [
        result.title,
        ...result.sections.map(({ heading }) => heading),
        ...claims.map(({ statement }) => statement),
      ];
      const byId = new Map(sources.map((source) => [source.source.sourceId, source]));
      const evidenceValid = claims.every(({ evidence }) =>
        evidence.every(({ quote, sourceId }) => {
          const retained = byId.get(sourceId);
          const normalizedQuote = normalize(quote);
          return (
            retained !== undefined &&
            normalizedQuote.length >= 16 &&
            normalize(retained.content).includes(normalizedQuote)
          );
        }),
      );
      if (
        sources.length === 0 ||
        encodedBytes > 128_000 ||
        claims.length > 64 ||
        !evidenceValid ||
        unsafeText.some(containsProviderIdentity)
      ) {
        return Effect.fail(
          unavailable(
            "fabricatedEvidence",
            "The synthesis contains uncited, unknown, fabricated, or oversized evidence",
          ),
        );
      }
      return Effect.succeed(result);
    }),
  );

const authorize = (ports: PortInterface, report: ResearchReport.Record) =>
  ports
    .authorize(report)
    .pipe(
      Effect.mapError((cause) =>
        unavailable(
          "authorizationDenied",
          "Current authority no longer permits Research Report synthesis",
          cause,
        ),
      ),
    );

const sameCompanyCost = (left: CompanyCost, right: CompanyCost) =>
  left.basis === right.basis &&
  left.inputTokens === right.inputTokens &&
  left.outputTokens === right.outputTokens &&
  left.providerOperationId === right.providerOperationId &&
  left.usdMicros === right.usdMicros;

const makeOperation = (
  report: ResearchReport.Record,
  sources: ReadonlyArray<ResearchCollector.RetainedSource>,
) =>
  digest(
    JSON.stringify({
      inputDigest: report.inputDigest,
      modelAccessPolicyVersion: report.modelAccessPolicyVersion,
      modelRoute: report.modelRoute,
      resourcePriceVersion: report.resourcePriceVersion,
      sources: sources.map(({ source }) => ({
        contentDigest: source.contentDigest,
        sourceId: source.sourceId,
        url: source.url,
      })),
    }),
  ).pipe(
    Effect.map((inputDigest): Operation => ({
      attemptCount: 0,
      companyCost: null,
      inputDigest,
      modelAccessPolicyVersion: report.modelAccessPolicyVersion,
      modelRoute: report.modelRoute,
      operationId: OperationId.make(`research-synthesis:${report.workflowId}`),
      resourcePriceVersion: report.resourcePriceVersion,
      resultDigest: null,
      resultKey: null,
      safeFailureCode: null,
      startedAt: null,
      state: "pending",
      workflowId: report.workflowId,
    })),
  );

const readCompleted = (
  ports: PortInterface,
  report: ResearchReport.Record,
  operation: Operation,
  sources: ReadonlyArray<ResearchCollector.RetainedSource>,
) =>
  Effect.gen(function* () {
    if (operation.resultKey === null || operation.resultDigest === null) {
      return yield* unavailable("storageUnavailable", "Completed synthesis evidence is incomplete");
    }
    const result = yield* ports.evidence.read(
      report.userId,
      operation.resultKey,
      operation.resultDigest,
    );
    yield* ports.recordCompanyCost(report, requireCompanyCost(operation));
    const validated = yield* validateSynthesis(result, sources);
    return completedFrom(operation, validated);
  });

const completedFrom = (operation: Operation, result: Result): Completed => {
  if (
    operation.companyCost === null ||
    operation.resultDigest === null ||
    operation.resultKey === null
  ) {
    throw new Error("Completed synthesis persistence omitted required evidence");
  }
  return {
    companyCost: operation.companyCost,
    operationId: operation.operationId,
    result,
    resultDigest: operation.resultDigest,
    resultKey: operation.resultKey,
  };
};

const requireCompanyCost = (operation: Operation) => {
  if (operation.companyCost === null) {
    throw new Error("Completed synthesis persistence omitted Company Cost evidence");
  }
  return operation.companyCost;
};

const boundedPromptSources = (sources: ReadonlyArray<ResearchCollector.RetainedSource>) => {
  let remaining = 60_000;
  return sources.map(({ content, source }) => {
    const retained = content.slice(0, Math.max(0, remaining));
    remaining -= retained.length;
    return { content: retained, source };
  });
};

const normalize = (value: string) => value.replaceAll(/\s+/gu, " ").trim();

const containsProviderIdentity = (value: string) =>
  /https?:\/\//iu.test(value) || /\b[0-9a-f]{64}\b/iu.test(value);

const digest = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map((bytes) =>
      ResearchReport.InputDigest.make(
        Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
    ),
  );

const unavailable = (reason: Unavailable["reason"], message: string, cause: unknown = reason) =>
  new Unavailable({ cause, message, reason });

export * as ResearchSynthesis from "./research-synthesis";
