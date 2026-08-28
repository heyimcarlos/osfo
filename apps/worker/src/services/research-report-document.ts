import { Context, Effect, Layer, Predicate, Result, Schema } from "effect";

import { ContentId } from "../domain/client-content";
import { DocumentArtifact } from "../domain/document-artifact";
import type { AuthorizationContext, Denied } from "./authorization";
import { ResearchCollector } from "./research-collector";
import {
  type ArtifactStore,
  type ArtifactValidator,
  type CostEvidence,
  type DisposableCompute,
  DocumentAuthorizationUnavailable,
  DocumentIntentDigest,
  DocumentSource,
  type StoredArtifact,
} from "./document-generation";
import type { ResearchReport } from "./research-report";
import { ResearchSynthesis } from "./research-synthesis";

/* oxlint-disable eslint/no-underscore-dangle -- Durable outcomes use Effect's conventional tag. */

export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "ResearchReportDocumentUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals([
      "account",
      "authorize",
      "cleanup",
      "compute",
      "inspect",
      "publish",
      "readSources",
      "recordUsage",
      "retain",
      "synthesize",
      "validate",
    ]),
    reason: Schema.Literals([
      "authorizationEnded",
      "costLimitExceeded",
      "intentConflict",
      "invalidArtifact",
      "recoveryPending",
      "storageUnavailable",
    ]),
  },
) {}

export interface PortInterface {
  readonly artifacts: ArtifactStore;
  readonly authorize: (
    report: ResearchReport.Record,
  ) => Effect.Effect<
    { readonly authorization: AuthorizationContext; readonly report: ResearchReport.Record },
    ResearchReport.Conflict | Denied | ResearchReport.NotFound | ResearchReport.Unavailable
  >;
  readonly claimPublication: (
    report: ResearchReport.Record,
    contentId: ContentId,
  ) => Effect.Effect<
    ResearchReport.Record,
    ResearchReport.Conflict | Denied | ResearchReport.NotFound | ResearchReport.Unavailable
  >;
  readonly completeSuccess: (
    report: ResearchReport.Record,
    contentId: ContentId,
  ) => Effect.Effect<
    ResearchReport.Record,
    ResearchReport.Conflict | ResearchReport.NotFound | ResearchReport.Unavailable
  >;
  readonly compute: DisposableCompute;
  readonly maximumComputeUsdMicros: bigint;
  readonly recordRenderCost: (
    report: ResearchReport.Record,
    renderCost: CostEvidence,
  ) => Effect.Effect<void, Unavailable>;
  readonly recordUsage: (
    report: ResearchReport.Record,
    artifact: DocumentArtifact.ArtifactRef,
    synthesisCost: ResearchSynthesis.CompanyCost,
    renderCost: CostEvidence,
  ) => Effect.Effect<void, Unavailable>;
  readonly validator: ArtifactValidator;
}

export class Port extends Context.Service<Port, PortInterface>()(
  "@osfo/ResearchReportDocument/Port",
) {}

export interface Interface {
  readonly generate: (
    report: ResearchReport.Record,
    collection: ResearchCollector.Collection,
  ) => Effect.Effect<
    { readonly artifact: DocumentArtifact.ArtifactRef; readonly report: ResearchReport.Record },
    Unavailable
  >;
}

export class Service extends Context.Service<Service, Interface>()(
  "@osfo/ResearchReportDocument",
) {}

export type TerminalDisposition =
  | { readonly _tag: "Canceled"; readonly safeFailureCode: string }
  | { readonly _tag: "Failure"; readonly safeFailureCode: string }
  | { readonly _tag: "RecoveryPending" }
  | null;

/** Convert only closed document outcomes into product-state consequences. */
export const terminalDispositionFor = (failure: Unavailable): TerminalDisposition => {
  if (failure.reason === "recoveryPending") return { _tag: "RecoveryPending" };
  if (failure.reason === "authorizationEnded") {
    return { _tag: "Canceled", safeFailureCode: "authority-ended" };
  }
  if (
    failure.reason === "costLimitExceeded" ||
    failure.reason === "intentConflict" ||
    failure.reason === "invalidArtifact"
  ) {
    return { _tag: "Failure", safeFailureCode: `document-${failure.reason}` };
  }
  return null;
};

export const make = Effect.gen(function* () {
  const ports = yield* Port;
  const collector = yield* ResearchCollector.Service;
  const synthesisService = yield* ResearchSynthesis.Service;

  const authorize = (report: ResearchReport.Record) =>
    ports
      .authorize(report)
      .pipe(
        Effect.mapError((cause) =>
          unavailable("authorize", "Research Report authority ended", cause, "authorizationEnded"),
        ),
      );

  const generate = Effect.fn("ResearchReportDocument.generate")(function* (
    admitted: ResearchReport.Record,
    collection: ResearchCollector.Collection,
  ) {
    const sources = yield* collector
      .read(admitted, collection)
      .pipe(
        Effect.mapError((cause) =>
          unavailable("readSources", "Retained citation evidence is unavailable", cause),
        ),
      );
    const synthesis = yield* synthesisService
      .synthesize(admitted, sources)
      .pipe(
        Effect.mapError((cause) =>
          unavailable("synthesize", "The cited Research Report could not be synthesized", cause),
        ),
      );
    const source = yield* documentSourceFor(synthesis.result, sources);
    const contentId = ContentId.make(`document:workflow:${admitted.workflowId}`);
    const owner = DocumentArtifact.DocumentOwner.make({
      _tag: "Workflow",
      workflowId: admitted.workflowId,
    });
    const intentDigest = yield* digestIntent(admitted.request.format, source);
    if (admitted.state !== "artifact_stored") yield* authorize(admitted);
    const existing = yield* ports.artifacts
      .inspect(contentId)
      .pipe(
        Effect.mapError((cause) =>
          unavailable("inspect", "The report artifact cannot be inspected", cause),
        ),
      );
    if (existing !== null) {
      if (
        existing.userId !== admitted.userId ||
        existing.intentDigest !== intentDigest ||
        existing.format !== admitted.request.format ||
        !DocumentArtifact.sameOwner(existing.owner, owner)
      ) {
        return yield* unavailable(
          "inspect",
          "The Workflow artifact identity already owns different immutable facts",
          existing,
          "intentConflict",
        );
      }
      const claimed = yield* claimPublication(ports, admitted, contentId);
      yield* account(ports, contentId);
      yield* ports.recordRenderCost(claimed, existing.cost);
      yield* ports.recordUsage(claimed, existing.artifact, synthesis.companyCost, existing.cost);
      const completed = yield* completeSuccess(ports, claimed, contentId);
      yield* cleanup(ports, contentId);
      return { artifact: existing.artifact, report: completed };
    }

    const authorizeWrite = ports.authorize(admitted).pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new DocumentAuthorizationUnavailable({
            cause,
            message: "Research Report authority ended during document compute",
          }),
      ),
    );
    let cleanupRequired = true;
    const generated = yield* Effect.gen(function* () {
      const computed = yield* ports.compute.generate({
        allowancePeriodId: admitted.allowancePeriodId,
        authorizeWrite,
        contentId,
        format: admitted.request.format,
        intentDigest,
        source,
        supportingVisuals: [],
        userId: admitted.userId,
      });
      if (Predicate.isTagged(computed, "AuthorizationFailure")) {
        yield* ports.recordRenderCost(admitted, computed.cost);
        return yield* unavailable(
          "authorize",
          "Research Report authority ended during document compute",
          computed.failure,
          "authorizationEnded",
        );
      }
      if (Predicate.isTagged(computed, "AttemptPending")) {
        cleanupRequired = false;
        yield* ports.recordRenderCost(admitted, computed.cost);
        return yield* unavailable(
          "compute",
          "Another invocation owns the disposable document attempt",
          computed.evidence,
          "recoveryPending",
        );
      }
      if (
        Predicate.isTagged(computed, "AttemptUnavailable") ||
        Predicate.isTagged(computed, "Interrupted")
      ) {
        yield* ports.recordRenderCost(admitted, computed.cost);
        return yield* unavailable(
          "compute",
          "Disposable document attempt evidence is incomplete",
          computed.evidence,
          "recoveryPending",
        );
      }
      if (Predicate.isTagged(computed, "IntentConflict")) {
        yield* ports.recordRenderCost(admitted, computed.cost);
        return yield* unavailable(
          "compute",
          "The Workflow document identity owns a changed compute intent",
          computed._tag,
          "intentConflict",
        );
      }
      if (Predicate.isTagged(computed, "RejectedOversize")) {
        yield* ports.recordRenderCost(admitted, computed.cost);
        return yield* unavailable(
          "validate",
          "The rendered report exceeds the immutable artifact byte limit",
          computed.size,
          "invalidArtifact",
        );
      }
      if (
        computed.cost._tag === "Incurred" &&
        computed.cost.usdMicros > ports.maximumComputeUsdMicros
      ) {
        yield* ports.recordRenderCost(admitted, computed.cost);
        return yield* unavailable(
          "compute",
          "Report document compute exceeded its admitted Company Cost bound",
          computed.cost,
          "costLimitExceeded",
        );
      }
      if (computed.renderedPageCount !== source.pages.length) {
        yield* ports.recordRenderCost(admitted, computed.cost);
        return yield* unavailable(
          "validate",
          "Rendered report pagination does not match its cited source",
          computed.renderedPageCount,
          "invalidArtifact",
        );
      }
      const artifact = yield* ports.validator
        .validate(contentId, admitted.request.format, computed.bytes, computed.renderedPageCount)
        .pipe(
          Effect.tapError(() => ports.recordRenderCost(admitted, computed.cost)),
          Effect.mapError((cause) =>
            unavailable("validate", "The report artifact is invalid", cause, "invalidArtifact"),
          ),
        );
      const retained: StoredArtifact = {
        allowancePeriodId: admitted.allowancePeriodId,
        artifact,
        bytes: computed.bytes,
        cost: computed.cost,
        format: admitted.request.format,
        intentDigest,
        owner,
        retention: "pending",
        userId: admitted.userId,
      };
      yield* authorize(admitted);
      yield* ports.artifacts
        .put(retained)
        .pipe(
          Effect.mapError((cause) =>
            unavailable("retain", "The report artifact cannot be retained", cause),
          ),
        );
      yield* ports.recordRenderCost(admitted, computed.cost);
      const claimed = yield* claimPublication(ports, admitted, contentId).pipe(
        Effect.tapError(() => ports.artifacts.delete(retained).pipe(Effect.ignore)),
      );
      yield* account(ports, contentId);
      yield* ports.recordUsage(claimed, artifact, synthesis.companyCost, computed.cost);
      const completed = yield* completeSuccess(ports, claimed, contentId);
      return { artifact, report: completed };
    }).pipe(Effect.result);
    if (cleanupRequired) yield* cleanup(ports, contentId);
    if (Result.isFailure(generated)) return yield* generated.failure;
    return generated.success;
  });

  return Service.of({ generate });
});

export const layerWithoutDependencies = Layer.effect(Service, make);

/** Render only validated synthesis, while generating URL/digest references from retained truth. */
export const documentSourceFor = (
  synthesis: ResearchSynthesis.Result,
  retained: ReadonlyArray<ResearchCollector.RetainedSource>,
): Effect.Effect<DocumentSource, Unavailable> => {
  const claimLines = (claims: ReadonlyArray<ResearchSynthesis.MaterialClaim>) =>
    claims.flatMap(({ evidence, statement }) => [
      ...wrap(`${statement} ${citations(evidence)}`),
      ...evidence.flatMap(({ quote, sourceId }) => wrap(`Evidence: “${quote}” [${sourceId}]`)),
    ]);
  const blocks = [
    {
      lines: claimLines(synthesis.summary),
      title: truncate(`${synthesis.title} — Executive summary`, 80),
    },
    ...synthesis.sections.map(({ heading, materialClaims }) => ({
      lines: claimLines(materialClaims),
      title: truncate(heading, 80),
    })),
    { lines: claimLines(synthesis.conclusion), title: "Conclusion" },
    {
      lines: retained.flatMap(({ source }) =>
        wrap(
          `[${source.sourceId}] ${source.title ?? "Untitled source"} — ${source.url} — SHA-256 ${source.contentDigest}`,
        ),
      ),
      title: "References",
    },
  ];
  const pages = blocks.flatMap(({ lines, title }) => paginate(title, lines));
  if (pages.length > 20) {
    return Effect.fail(
      unavailable(
        "validate",
        "The bounded cited report cannot fit within the 20-page document limit",
        { pageCount: pages.length },
        "invalidArtifact",
      ),
    );
  }
  return Schema.decodeEffect(DocumentSource)({ pages }).pipe(
    Effect.mapError((cause) =>
      unavailable("validate", "The cited report pagination is invalid", cause, "invalidArtifact"),
    ),
  );
};

const paginate = (title: string, lines: ReadonlyArray<string>) => {
  const pageCount = Math.max(1, Math.ceil(lines.length / 30));
  return Array.from({ length: pageCount }, (_, index) => ({
    lines: lines.slice(index * 30, (index + 1) * 30),
    title: truncate(pageCount === 1 ? title : `${title} (${index + 1}/${pageCount})`, 80),
  }));
};

const citations = (evidence: ReadonlyArray<typeof ResearchSynthesis.EvidenceQuote.Type>) =>
  [...new Set(evidence.map(({ sourceId }) => sourceId))]
    .map((sourceId) => `[${sourceId}]`)
    .join("");

const wrap = (value: string) => {
  const words = value.replaceAll(/\s+/gu, " ").trim().split(" ");
  return words.reduce<ReadonlyArray<string>>((lines, word) => {
    const bounded = truncate(word, 80);
    const previous = lines.at(-1);
    if (previous === undefined || previous.length + bounded.length + 1 > 80) {
      return lines.concat(bounded);
    }
    return lines.slice(0, -1).concat(`${previous} ${bounded}`);
  }, []);
};

const truncate = (value: string, maximum: number) => value.trim().slice(0, maximum) || "Report";

const digestIntent = (format: "docx" | "pdf", source: DocumentSource) =>
  Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({ format: DocumentArtifact.DocumentFormat, source: DocumentSource }),
    ),
  )({ format, source }).pipe(
    Effect.orDie,
    Effect.flatMap((encoded) =>
      Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded))),
    ),
    Effect.map((digest) =>
      DocumentIntentDigest.make(
        Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
    ),
  );

const claimPublication = (
  ports: PortInterface,
  report: ResearchReport.Record,
  contentId: ContentId,
) =>
  ports
    .claimPublication(report, contentId)
    .pipe(
      Effect.mapError((cause) =>
        unavailable("publish", "Artifact publication cannot be claimed", cause),
      ),
    );

const completeSuccess = (
  ports: PortInterface,
  report: ResearchReport.Record,
  contentId: ContentId,
) =>
  ports
    .completeSuccess(report, contentId)
    .pipe(
      Effect.mapError((cause) =>
        unavailable("publish", "Report success cannot be committed", cause),
      ),
    );

const account = (ports: PortInterface, contentId: ContentId) =>
  ports.artifacts
    .account(contentId)
    .pipe(
      Effect.mapError((cause) =>
        unavailable("account", "The report artifact cannot be made readable", cause),
      ),
    );

const cleanup = (ports: PortInterface, contentId: ContentId) =>
  ports.compute
    .dispose(contentId)
    .pipe(
      Effect.mapError((cause) =>
        unavailable("cleanup", "Disposable report compute cannot be released", cause),
      ),
    );

const unavailable = (
  operation: Unavailable["operation"],
  message: string,
  cause: unknown = operation,
  reason: Unavailable["reason"] = "storageUnavailable",
) => new Unavailable({ cause, message, operation, reason });

export * as ResearchReportDocument from "./research-report-document";
