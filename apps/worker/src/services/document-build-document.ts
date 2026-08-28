import { Context, Effect, Layer, Predicate, Result, Schema } from "effect";

import { ContentId } from "../domain/client-content";
import { DocumentArtifact } from "../domain/document-artifact";
import type { Denied } from "./authorization";
import { DocumentBuild } from "./document-build";
import {
  type ArtifactStore,
  type ArtifactValidator,
  type CostEvidence,
  type DisposableCompute,
  DocumentAuthorizationUnavailable,
  DocumentIntentDigest,
  type StoredArtifact,
  type StoredArtifactMetadata,
} from "./document-generation";

/* oxlint-disable eslint/no-underscore-dangle, typescript/consistent-return -- Durable outcomes use Effect's conventional tag and generator branches fail through Effect. */

export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "DocumentBuildDocumentUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals([
      "account",
      "accounting",
      "authorize",
      "cleanup",
      "compute",
      "inspect",
      "preview",
      "publish",
      "retain",
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
    build: DocumentBuild.Record,
  ) => Effect.Effect<
    DocumentBuild.Record,
    DocumentBuild.Conflict | Denied | DocumentBuild.NotFound | DocumentBuild.Unavailable
  >;
  readonly commitAccounting: (
    build: DocumentBuild.Record,
    contentId: ContentId,
    cost: CostEvidence,
  ) => Effect.Effect<
    DocumentBuild.Record,
    DocumentBuild.Conflict | Denied | DocumentBuild.NotFound | DocumentBuild.Unavailable
  >;
  readonly commitPublication: (
    build: DocumentBuild.Record,
    contentId: ContentId,
  ) => Effect.Effect<
    DocumentBuild.Record,
    DocumentBuild.Conflict | Denied | DocumentBuild.NotFound | DocumentBuild.Unavailable
  >;
  readonly compute: DisposableCompute;
  readonly finishSuccess: (
    build: DocumentBuild.Record,
    contentId: ContentId,
  ) => Effect.Effect<
    DocumentBuild.Record,
    DocumentBuild.Conflict | DocumentBuild.NotFound | DocumentBuild.Unavailable
  >;
  readonly markPreviewStored: (
    build: DocumentBuild.Record,
    contentId: ContentId,
  ) => Effect.Effect<
    DocumentBuild.Record,
    DocumentBuild.Conflict | Denied | DocumentBuild.NotFound | DocumentBuild.Unavailable
  >;
  readonly maximumComputeUsdMicros: bigint;
  readonly recordGeneratedDocument: (
    build: DocumentBuild.Record,
    artifact: DocumentArtifact.ArtifactRef,
    cost: CostEvidence,
  ) => Effect.Effect<void, Unavailable>;
  readonly recordProviderCost: (
    build: DocumentBuild.Record,
    contentId: ContentId,
    cost: CostEvidence,
  ) => Effect.Effect<void, Unavailable>;
  readonly validator: ArtifactValidator;
}

export class Port extends Context.Service<Port, PortInterface>()(
  "@osfo/DocumentBuildDocument/Port",
) {}

export interface Interface {
  readonly discard: (build: DocumentBuild.Record) => Effect.Effect<void, Unavailable>;
  readonly generate: (
    build: DocumentBuild.Record,
  ) => Effect.Effect<
    { readonly artifact: DocumentArtifact.ArtifactRef; readonly build: DocumentBuild.Record },
    Unavailable
  >;
}

export class Service extends Context.Service<Service, Interface>()("@osfo/DocumentBuildDocument") {}

export type TerminalDisposition =
  | { readonly _tag: "Canceled"; readonly safeFailureCode: string }
  | { readonly _tag: "Failure"; readonly safeFailureCode: string }
  | { readonly _tag: "RecoveryPending" }
  | null;

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

  const authorize = (build: DocumentBuild.Record) =>
    ports
      .authorize(build)
      .pipe(
        Effect.mapError((cause) =>
          unavailable("authorize", "Document Build authority ended", cause, "authorizationEnded"),
        ),
      );

  const discard = Effect.fn("DocumentBuildDocument.discard")(function* (
    build: DocumentBuild.Record,
  ) {
    const contentId = contentIdFor(build);
    const existing = yield* inspect(ports, contentId);
    if (existing !== null) {
      if (!sameIdentity(existing, build, yield* digestIntent(build))) {
        return yield* unavailable(
          "inspect",
          "The canceled Document Build artifact owns different immutable facts",
          existing,
          "intentConflict",
        );
      }
      yield* discardArtifact(ports, existing);
    }
    yield* cleanup(ports, contentId);
  });

  const generate = Effect.fn("DocumentBuildDocument.generate")(function* (
    admitted: DocumentBuild.Record,
  ) {
    const contentId = contentIdFor(admitted);
    const intentDigest = yield* digestIntent(admitted);
    const existing = yield* inspect(ports, contentId);
    if (existing !== null) {
      if (!sameIdentity(existing, admitted, intentDigest)) {
        return yield* unavailable(
          "inspect",
          "The Workflow artifact identity already owns changed immutable facts",
          existing,
          "intentConflict",
        );
      }
      const completed = yield* publishRetained(ports, admitted, existing);
      return { artifact: existing.artifact, build: completed };
    }

    yield* authorize(admitted);
    let cleanupRequired = true;
    const generated = yield* Effect.gen(function* () {
      const authorizeWrite = authorize(admitted).pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new DocumentAuthorizationUnavailable({
              cause,
              message: "Document Build authority ended during document compute",
            }),
        ),
      );
      const computed = yield* ports.compute.generate({
        allowancePeriodId: admitted.allowancePeriodId,
        authorizeWrite,
        contentId,
        format: admitted.request.format,
        intentDigest,
        source: admitted.request.source,
        supportingVisuals: [],
        userId: admitted.userId,
      });
      yield* ports.recordProviderCost(admitted, contentId, computed.cost);
      if (Predicate.isTagged(computed, "AuthorizationFailure")) {
        return yield* unavailable(
          "authorize",
          "Document Build authority ended during compute",
          computed.failure,
          "authorizationEnded",
        );
      }
      if (
        Predicate.isTagged(computed, "AttemptPending") ||
        Predicate.isTagged(computed, "AttemptUnavailable") ||
        Predicate.isTagged(computed, "Interrupted")
      ) {
        cleanupRequired = false;
        return yield* unavailable(
          "compute",
          "Document Build compute requires evidence reconciliation",
          computed.evidence,
          "recoveryPending",
        );
      }
      if (Predicate.isTagged(computed, "IntentConflict")) {
        return yield* unavailable(
          "compute",
          "The Workflow document identity owns changed compute intent",
          computed._tag,
          "intentConflict",
        );
      }
      if (Predicate.isTagged(computed, "RejectedOversize")) {
        return yield* unavailable(
          "validate",
          "The generated Document Build exceeds 5 MB",
          computed.size,
          "invalidArtifact",
        );
      }
      if (
        computed.cost._tag === "Incurred" &&
        computed.cost.usdMicros > ports.maximumComputeUsdMicros
      ) {
        return yield* unavailable(
          "compute",
          "Document Build compute exceeded its admitted Company Cost bound",
          computed.cost,
          "costLimitExceeded",
        );
      }
      if (computed.renderedPageCount !== admitted.request.source.pages.length) {
        return yield* unavailable(
          "validate",
          "Rendered pagination does not match the immutable source",
          computed.renderedPageCount,
          "invalidArtifact",
        );
      }
      const artifact = yield* ports.validator
        .validate(contentId, admitted.request.format, computed.bytes, computed.renderedPageCount)
        .pipe(
          Effect.mapError((cause) =>
            unavailable(
              "validate",
              "The generated Document Build is invalid",
              cause,
              "invalidArtifact",
            ),
          ),
        );
      const retained: StoredArtifact = {
        allowancePeriodId: admitted.allowancePeriodId,
        artifact,
        bytes: computed.bytes,
        cost: computed.cost,
        format: admitted.request.format,
        intentDigest,
        owner: ownerFor(admitted),
        retention: "pending",
        userId: admitted.userId,
      };
      yield* authorize(admitted);
      yield* ports.artifacts
        .put(retained)
        .pipe(
          Effect.mapError((cause) =>
            unavailable("retain", "The validated Document Build cannot be retained", cause),
          ),
        );
      const completed = yield* publishRetained(ports, admitted, retained).pipe(
        Effect.tapError((failure) =>
          failure.reason === "authorizationEnded" ||
          failure.reason === "intentConflict" ||
          Schema.is(DocumentBuild.Conflict)(failure.cause)
            ? discardArtifact(ports, retained).pipe(Effect.ignore)
            : Effect.void,
        ),
      );
      cleanupRequired = false;
      return { artifact, build: completed };
    }).pipe(Effect.result);
    if (cleanupRequired) yield* cleanup(ports, contentId);
    if (Result.isFailure(generated)) return yield* generated.failure;
    return generated.success;
  });

  return Service.of({ discard, generate });
});

export const layerWithoutDependencies = Layer.effect(Service, make);

const publishRetained = Effect.fn("DocumentBuildDocument.publishRetained")(function* (
  ports: PortInterface,
  admitted: DocumentBuild.Record,
  retained: StoredArtifactMetadata,
) {
  const contentId = retained.artifact.content.contentId;
  const preview = yield* ports
    .markPreviewStored(admitted, contentId)
    .pipe(
      Effect.mapError((cause) =>
        unavailable("preview", "Preview retention lost its state race", cause),
      ),
    );
  yield* ports.recordProviderCost(preview, contentId, retained.cost);
  const accounted = yield* ports
    .commitAccounting(preview, contentId, retained.cost)
    .pipe(
      Effect.mapError((cause) =>
        unavailable("accounting", "Usage evidence cannot be committed", cause),
      ),
    );
  yield* ports
    .authorize(accounted)
    .pipe(
      Effect.mapError((cause) =>
        unavailable("authorize", "Authority ended before publication", cause, "authorizationEnded"),
      ),
    );
  const published = yield* ports
    .commitPublication(accounted, contentId)
    .pipe(
      Effect.mapError((cause) => unavailable("publish", "Publication lost its state race", cause)),
    );
  yield* ports.recordGeneratedDocument(published, retained.artifact, retained.cost);
  yield* ports.artifacts
    .account(contentId)
    .pipe(
      Effect.mapError((cause) =>
        unavailable("account", "The artifact cannot be made readable", cause),
      ),
    );
  yield* cleanup(ports, contentId);
  return yield* ports
    .finishSuccess(published, contentId)
    .pipe(Effect.mapError((cause) => unavailable("publish", "Success cannot be committed", cause)));
});

const inspect = (ports: PortInterface, contentId: ContentId) =>
  ports.artifacts
    .inspect(contentId)
    .pipe(
      Effect.mapError((cause) =>
        unavailable("inspect", "The Document Build artifact cannot be inspected", cause),
      ),
    );

const cleanup = (ports: PortInterface, contentId: ContentId) =>
  ports.compute
    .dispose(contentId)
    .pipe(
      Effect.mapError((cause) =>
        unavailable("cleanup", "Disposable compute cannot be released", cause),
      ),
    );

const discardArtifact = (ports: PortInterface, artifact: StoredArtifactMetadata) =>
  ports.artifacts
    .delete(artifact)
    .pipe(
      Effect.mapError((cause) =>
        unavailable("cleanup", "The pending artifact cannot be removed", cause),
      ),
    );

const contentIdFor = (build: DocumentBuild.Record) =>
  ContentId.make(`document:workflow:${build.workflowId}`);

const ownerFor = (build: DocumentBuild.Record) =>
  DocumentArtifact.DocumentOwner.make({ _tag: "Workflow", workflowId: build.workflowId });

const sameIdentity = (
  artifact: StoredArtifactMetadata,
  build: DocumentBuild.Record,
  intentDigest: DocumentIntentDigest,
) =>
  artifact.userId === build.userId &&
  artifact.allowancePeriodId === build.allowancePeriodId &&
  artifact.intentDigest === intentDigest &&
  artifact.format === build.request.format &&
  DocumentArtifact.sameOwner(artifact.owner, ownerFor(build));

const digestIntent = (build: DocumentBuild.Record) =>
  Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        format: DocumentArtifact.DocumentFormat,
        source: Schema.toType(DocumentBuild.StoredRequest.fields.source),
      }),
    ),
  )({ format: build.request.format, source: build.request.source }).pipe(
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

const unavailable = (
  operation: Unavailable["operation"],
  message: string,
  cause: unknown = operation,
  reason: Unavailable["reason"] = "storageUnavailable",
) => new Unavailable({ cause, message, operation, reason });

export * as DocumentBuildDocument from "./document-build-document";
