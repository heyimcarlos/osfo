import { Context, DateTime, Effect, Layer, Predicate, Ref, Schedule, Schema } from "effect";

import { currentCapabilityCatalog } from "../domain/capability-catalog";
import type { Denied } from "./authorization";
import { ResearchReport } from "./research-report";
import type { DiscoveryResult, PageFetch } from "./web";
import { isSafePublicUrl, limits } from "./web";

/* oxlint-disable eslint/no-underscore-dangle -- Provider outcomes use the standard Effect _tag discriminator. */

const boundedText = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

export const OperationId = boundedText(300).pipe(Schema.brand("ResearchReportOperationId"));
export type OperationId = typeof OperationId.Type;

export const OperationInput = Schema.Union([
  Schema.TaggedStruct("Search", {
    limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(10)),
    query: boundedText(500),
  }),
  Schema.TaggedStruct("Page", { url: boundedText(4_096) }),
]);
export type OperationInput = typeof OperationInput.Type;

const SearchItem = Schema.Struct({
  title: boundedText(2_000),
  url: boundedText(4_096),
});

export const OperationResult = Schema.Union([
  Schema.TaggedStruct("Search", {
    query: boundedText(500),
    requestId: boundedText(512),
    results: Schema.Array(SearchItem).check(Schema.isMaxLength(10)),
  }),
  Schema.TaggedStruct("Page", {
    contentKey: boundedText(1_024),
    contentDigest: ResearchReport.InputDigest,
    contentType: Schema.String,
    fetchedAt: Schema.DateFromString,
    finalUrl: boundedText(4_096),
    title: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("PageUnavailable", {
    reason: Schema.Literals(["inaccessible", "oversized", "unsafeUrl", "unsupportedContent"]),
    url: boundedText(4_096),
  }),
]);
export type OperationResult = typeof OperationResult.Type;

export const OperationState = Schema.Literals([
  "pending",
  "completed",
  "unknown",
  "failed",
  "canceled",
]);
export type OperationState = typeof OperationState.Type;

export interface Operation {
  readonly operationId: OperationId;
  readonly workflowId: ResearchReport.WorkflowId;
  readonly sequence: number;
  readonly input: OperationInput;
  readonly inputDigest: ResearchReport.InputDigest;
  readonly attemptCount: number;
  readonly state: OperationState;
  readonly result: OperationResult | null;
}

export const ManifestSource = Schema.Struct({
  contentDigest: ResearchReport.InputDigest,
  contentKey: boundedText(1_024),
  fetchedAt: Schema.DateFromString,
  sourceId: boundedText(300),
  title: Schema.NullOr(Schema.String),
  url: boundedText(4_096),
});
export type ManifestSource = typeof ManifestSource.Type;

export const SourceManifest = Schema.Struct({
  sources: Schema.Array(ManifestSource).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(currentCapabilityCatalog.operationLimits.researchRetrievedPages),
  ),
  version: Schema.Literal("research-source-manifest-v1"),
  workflowId: ResearchReport.WorkflowId,
});
export type SourceManifest = typeof SourceManifest.Type;

export interface Collection {
  readonly manifest: SourceManifest;
  readonly manifestKey: string;
  readonly pages: ReadonlyArray<Extract<OperationResult, { readonly _tag: "Page" }>>;
}

export class Conflict extends Schema.TaggedError<Conflict>()("ResearchCollectorConflict", {
  message: Schema.String,
  operationId: OperationId,
}) {}

export class Unavailable extends Schema.TaggedError<Unavailable>()("ResearchCollectorUnavailable", {
  cause: Schema.Defect(),
  message: Schema.String,
  reason: Schema.Literals([
    "ambiguousOperation",
    "authorizationDenied",
    "insufficientEvidence",
    "providerUnavailable",
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
  readonly persistence: {
    readonly claim: (operation: Operation) => Effect.Effect<
      | { readonly _tag: "Created"; readonly operation: Operation }
      | {
          readonly _tag: "Existing";
          readonly operation: Operation;
        },
      Conflict | Unavailable
    >;
    readonly complete: (
      operation: Operation,
      result: OperationResult,
    ) => Effect.Effect<Operation, Conflict | Unavailable>;
    readonly finish: (
      operation: Operation,
      state: "canceled" | "failed" | "unknown",
      safeFailureCode: string,
    ) => Effect.Effect<void, Unavailable>;
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
    readonly discover: (
      query: string,
      limit: number,
    ) => Effect.Effect<DiscoveryResult, { readonly retry: "ambiguous" | "never" | "transient" }>;
    readonly fetchPage: (input: {
      readonly url: string;
    }) => Effect.Effect<PageFetch, { readonly retry: "ambiguous" | "never" | "transient" }>;
  };
  readonly sourceEvidence: {
    readonly putManifest: (
      userId: ResearchReport.Record["userId"],
      manifest: SourceManifest,
    ) => Effect.Effect<string, Unavailable>;
    readonly removeManifest: (
      userId: ResearchReport.Record["userId"],
      workflowId: ResearchReport.WorkflowId,
    ) => Effect.Effect<void, Unavailable>;
    readonly removePage: (
      userId: ResearchReport.Record["userId"],
      contentKey: string,
    ) => Effect.Effect<void, Unavailable>;
    readonly put: (input: {
      readonly content: string;
      readonly contentDigest: ResearchReport.InputDigest;
      readonly contentType: string;
      readonly fetchedAt: Date;
      readonly finalUrl: string;
      readonly operationId: OperationId;
      readonly title: string | null;
      readonly userId: ResearchReport.Record["userId"];
    }) => Effect.Effect<Extract<OperationResult, { readonly _tag: "Page" }>, Unavailable>;
    readonly reconcile: (
      userId: ResearchReport.Record["userId"],
      operationId: OperationId,
    ) => Effect.Effect<Extract<OperationResult, { readonly _tag: "Page" }> | null, Unavailable>;
  };
}

export class Port extends Context.Service<Port, PortInterface>()("@osfo/ResearchCollector/Port") {}

export interface Interface {
  readonly collect: (
    report: ResearchReport.Record,
  ) => Effect.Effect<Collection, Conflict | Unavailable>;
  readonly discard: (
    report: ResearchReport.Record,
    collection: Collection,
  ) => Effect.Effect<void, Unavailable>;
}

export class Service extends Context.Service<Service, Interface>()("@osfo/ResearchCollector") {}

export const make = Effect.gen(function* () {
  const ports = yield* Port;

  const authorize = (report: ResearchReport.Record) =>
    ports.authorize(report).pipe(
      Effect.mapError(
        (cause) =>
          new Unavailable({
            cause,
            message: "Current authority no longer permits Research Report provider work",
            reason: "authorizationDenied",
          }),
      ),
    );

  const execute = Effect.fn("ResearchCollector.execute")(function* (
    report: ResearchReport.Record,
    sequence: number,
    input: OperationInput,
  ) {
    yield* authorize(report);
    const operation = yield* makeOperation(report.workflowId, sequence, input);
    const claim = yield* ports.persistence.claim(operation);
    if (claim.operation.inputDigest !== operation.inputDigest) {
      return yield* new Conflict({
        message: "The provider operation identity was replayed with changed input",
        operationId: operation.operationId,
      });
    }
    if (claim.operation.state === "completed" && claim.operation.result !== null) {
      return claim.operation.result;
    }
    if (claim._tag === "Existing" && claim.operation.state !== "pending") {
      return yield* new Unavailable({
        cause: claim.operation.state,
        message: "A prior provider operation has no safely replayable result",
        reason: "ambiguousOperation",
      });
    }
    if (claim._tag === "Existing" && claim.operation.attemptCount > 0) {
      if (Predicate.isTagged(operation.input, "Page")) {
        const reconciled = yield* ports.sourceEvidence.reconcile(
          report.userId,
          operation.operationId,
        );
        if (reconciled !== null) {
          const completed = yield* ports.persistence.complete(operation, reconciled);
          if (completed.result !== null) return completed.result;
        }
      }
      return yield* new Unavailable({
        cause: claim.operation.state,
        message: "A prior provider operation has no safely replayable result",
        reason: "ambiguousOperation",
      });
    }
    const result = yield* runProvider(ports, report, operation);
    const rechecked = yield* authorize(report).pipe(Effect.result);
    if (rechecked._tag === "Failure") {
      if (Predicate.isTagged(result, "Page")) {
        yield* ports.sourceEvidence.removePage(report.userId, result.contentKey);
      }
      yield* ports.persistence.finish(operation, "canceled", "authority-lost-after-provider");
      return yield* new Unavailable({
        cause: rechecked.failure,
        message: "Research Report authority ended during provider work",
        reason: "authorizationDenied",
      });
    }
    const completed = yield* ports.persistence.complete(operation, result);
    if (completed.result === null) {
      return yield* new Unavailable({
        cause: completed.state,
        message: "Completed provider state has no retained result",
        reason: "storageUnavailable",
      });
    }
    return completed.result;
  });

  const collect = Effect.fn("ResearchCollector.collect")(function* (report: ResearchReport.Record) {
    const searchResults = yield* Effect.forEach(
      report.request.queries,
      (query, index) =>
        execute(report, index, OperationInput.make({ _tag: "Search", limit: 10, query })),
      { concurrency: 1 },
    );
    const urls = searchResults
      .filter(isSearchResult)
      .flatMap(({ results }) => results.map(({ url }) => url))
      .filter(isSafePublicUrl)
      .filter((url, index, all) => all.indexOf(url) === index)
      .slice(0, currentCapabilityCatalog.operationLimits.researchRetrievedPages);
    const pageResults = yield* Effect.forEach(
      urls,
      (url, index) =>
        execute(
          report,
          report.request.queries.length + index,
          OperationInput.make({ _tag: "Page", url }),
        ),
      { concurrency: 1 },
    );
    const pages = pageResults.filter(isPageResult).filter(isReadablePage);
    if (pages.length === 0) {
      return yield* new Unavailable({
        cause: "no readable fetched pages",
        message: "The Research Report has insufficient fetched citation evidence",
        reason: "insufficientEvidence",
      });
    }
    const manifest = SourceManifest.make({
      sources: pages.map((page, index) => ({
        contentDigest: page.contentDigest,
        contentKey: page.contentKey,
        fetchedAt: page.fetchedAt,
        sourceId: `${report.workflowId}:source:${index}`,
        title: page.title,
        url: page.finalUrl,
      })),
      version: "research-source-manifest-v1",
      workflowId: report.workflowId,
    });
    yield* authorize(report);
    const manifestKey = yield* ports.sourceEvidence.putManifest(report.userId, manifest);
    return { manifest, manifestKey, pages };
  });

  const discard = Effect.fn("ResearchCollector.discard")(function* (
    report: ResearchReport.Record,
    collection: Collection,
  ) {
    yield* ports.sourceEvidence.removeManifest(report.userId, report.workflowId);
    yield* Effect.forEach(
      collection.pages,
      (page) => ports.sourceEvidence.removePage(report.userId, page.contentKey),
      { concurrency: 1, discard: true },
    );
  });

  return Service.of({ collect, discard });
});

export const layerWithoutDependencies = Layer.effect(Service, make);

const runProvider = (
  ports: PortInterface,
  report: ResearchReport.Record,
  operation: Operation,
): Effect.Effect<OperationResult, Unavailable> =>
  Effect.gen(function* () {
    const expectedAttemptCount = yield* Ref.make(operation.attemptCount);
    const provider = Effect.gen(function* () {
      const expected = yield* Ref.get(expectedAttemptCount);
      const attempt = yield* ports.persistence.recordAttempt(operation.operationId, expected);
      if (attempt._tag === "InFlight") {
        if (Predicate.isTagged(operation.input, "Page")) {
          const reconciled = yield* ports.sourceEvidence.reconcile(
            report.userId,
            operation.operationId,
          );
          if (reconciled !== null) return reconciled;
        }
        return yield* new Unavailable({
          cause: attempt.operation.attemptCount,
          message: "Another execution owns the in-flight provider operation",
          reason: "ambiguousOperation",
        });
      }
      yield* Ref.set(expectedAttemptCount, attempt.operation.attemptCount);
      return yield* providerEffect(ports, report, operation);
    });
    return yield* provider.pipe(
      Effect.retry({
        schedule: Schedule.recurs(1),
        while: (failure) => "retry" in failure && failure.retry === "transient",
      }),
      Effect.catch((failure) => {
        if (Predicate.isTagged(failure, "ResearchCollectorUnavailable")) {
          return Effect.fail(failure);
        }
        const ambiguous = failure.retry === "ambiguous";
        return ports.persistence
          .finish(
            operation,
            ambiguous ? "unknown" : "failed",
            ambiguous ? "ambiguous-provider-acceptance-company-cost" : "provider-unavailable",
          )
          .pipe(
            Effect.andThen(
              Effect.fail(
                new Unavailable({
                  cause: failure,
                  message: ambiguous
                    ? "The provider acceptance outcome is ambiguous"
                    : "The public-web provider operation failed",
                  reason: ambiguous ? "ambiguousOperation" : "providerUnavailable",
                }),
              ),
            ),
          );
      }),
    );
  });

const providerEffect = (
  ports: PortInterface,
  report: ResearchReport.Record,
  operation: Operation,
): Effect.Effect<
  OperationResult,
  Unavailable | { readonly retry: "ambiguous" | "never" | "transient" }
> => {
  if (Predicate.isTagged(operation.input, "Search")) {
    const input = operation.input;
    return ports.provider
      .discover(input.query, input.limit)
      .pipe(Effect.map((result) => searchResult(input, result)));
  }
  return ports.provider
    .fetchPage({ url: operation.input.url })
    .pipe(Effect.flatMap((page) => pageResult(ports, report, operation.operationId, page)));
};

const searchResult = (
  input: Extract<OperationInput, { readonly _tag: "Search" }>,
  result: DiscoveryResult,
): OperationResult => ({
  _tag: "Search",
  query: input.query,
  requestId: result.evidence.requestId,
  results: result.results.map((item) => ({
    title: item.title,
    url: item.url,
  })),
});

const pageResult = (
  ports: PortInterface,
  report: ResearchReport.Record,
  operationId: OperationId,
  page: PageFetch,
) =>
  Effect.gen(function* () {
    const unavailable = unreadablePage(page);
    if (unavailable !== null) return unavailable;
    const fetchedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    const contentDigest = yield* digest(page.content);
    return yield* ports.sourceEvidence.put({
      content: page.content,
      contentDigest,
      contentType: page.contentType,
      fetchedAt,
      finalUrl: page.finalUrl,
      operationId,
      title: page.title,
      userId: report.userId,
    });
  });

const unreadablePage = (
  page: PageFetch,
): Extract<OperationResult, { readonly _tag: "PageUnavailable" }> | null => {
  if (
    page.redirects.some((redirect) => !isSafePublicUrl(redirect)) ||
    !isSafePublicUrl(page.finalUrl)
  ) {
    return { _tag: "PageUnavailable", reason: "unsafeUrl", url: page.finalUrl };
  }
  if (page.status < 200 || page.status >= 300) {
    return { _tag: "PageUnavailable", reason: "inaccessible", url: page.finalUrl };
  }
  if (
    page.fetchedBytes > limits.fetchedPageBytes ||
    page.normalizedBytes > limits.normalizedPageBytes
  ) {
    return { _tag: "PageUnavailable", reason: "oversized", url: page.finalUrl };
  }
  const contentType = page.contentType.toLowerCase();
  const readable = ["text/html", "application/xhtml+xml", "text/plain", "text/markdown"].some(
    (supported) => contentType.includes(supported),
  );
  if (!readable || page.content.trim().length === 0) {
    return { _tag: "PageUnavailable", reason: "unsupportedContent", url: page.finalUrl };
  }
  return null;
};

const makeOperation = (
  workflowId: ResearchReport.WorkflowId,
  sequence: number,
  input: OperationInput,
) =>
  Schema.encodeEffect(Schema.fromJsonString(OperationInput))(input).pipe(
    Effect.orDie,
    Effect.flatMap(digest),
    Effect.map((inputDigest) => ({
      attemptCount: 0,
      input,
      inputDigest,
      operationId: OperationId.make(`${workflowId}:provider:${sequence}`),
      result: null,
      sequence,
      state: "pending" as const,
      workflowId,
    })),
  );

const digest = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map((bytes) =>
      ResearchReport.InputDigest.make(
        Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
    ),
  );

const isReadablePage = (page: Extract<OperationResult, { readonly _tag: "Page" }>) =>
  isSafePublicUrl(page.finalUrl);

const isSearchResult = (
  result: OperationResult,
): result is Extract<OperationResult, { readonly _tag: "Search" }> =>
  Predicate.isTagged(result, "Search");

const isPageResult = (
  result: OperationResult,
): result is Extract<OperationResult, { readonly _tag: "Page" }> =>
  Predicate.isTagged(result, "Page");

export * as ResearchCollector from "./research-collector";
