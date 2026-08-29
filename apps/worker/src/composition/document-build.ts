import { DateTime, Effect, Layer, Schema } from "effect";

import type { Database } from "@osfo/db";
import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { Db } from "../db";
import { BillingDb } from "../db/billing";
import { ContentId } from "../domain/client-content";
import { DocumentArtifact } from "../domain/document-artifact";
import { retainedCatalog } from "../domain/plan-policy";
import { DocumentArtifactValidation } from "../integrations/cloudflare/document-artifact-validation";
import { DocumentArtifacts } from "../integrations/cloudflare/document-artifacts";
import { DocumentBuildPostgres } from "../integrations/postgres/document-build";
import { DocumentBuildFollowUpPostgres } from "../integrations/postgres/document-build-follow-up";
import { Allowances } from "../services/allowances";
import { DocumentBuild } from "../services/document-build";
import { DocumentBuildAccounting } from "../services/document-build-accounting";
import { DocumentBuildDocument } from "../services/document-build-document";
import { DocumentBuildFollowUp } from "../services/document-build-follow-up";
import type { StoredArtifactMetadata } from "../services/document-generation";

/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide, eslint/no-underscore-dangle, osfo/no-unknown-returns, typescript/consistent-return -- This module is the Document Build application composition root. Cloudflare RPC returns are untrusted and decoded immediately after the Promise boundary. */

type WorkflowInstanceHandle = Pick<WorkflowInstance, "restart" | "status" | "terminate">;

export interface WorkflowBinding {
  readonly create: (options: {
    readonly id: string;
    readonly params: DocumentBuild.WorkflowPayload;
  }) => Promise<WorkflowInstanceHandle>;
  readonly get: (id: string) => Promise<WorkflowInstanceHandle>;
}

export interface DirectoryBinding {
  readonly getByName: (name: string) => {
    readonly resolveDocumentBuildFiles: (
      input: DocumentBuild.FileResolutionRequest,
    ) => Promise<unknown>;
    readonly submitDocumentBuildFollowUp: (notificationId: string) => Promise<unknown>;
  };
}

export interface Bindings {
  readonly ARTIFACTS: R2Bucket;
  readonly DB: Pick<Hyperdrive, "connectionString">;
  readonly DOCUMENT_BUILD_TIMER_WORKFLOW: WorkflowBinding;
  readonly DOCUMENT_BUILD_WORKFLOW: WorkflowBinding;
  readonly DOCUMENT_SANDBOX: Env["DOCUMENT_SANDBOX"];
  readonly OSFO_DIRECTORY: DirectoryBinding;
}

export const maximumDocumentBuildComputeUsdMicros = 50_000n;

export const bindingsFromEnv = (env: Env): Bindings => ({
  ARTIFACTS: env.ARTIFACTS,
  DB: env.DB,
  DOCUMENT_BUILD_TIMER_WORKFLOW: env.DOCUMENT_BUILD_TIMER_WORKFLOW,
  DOCUMENT_BUILD_WORKFLOW: env.DOCUMENT_BUILD_WORKFLOW,
  DOCUMENT_SANDBOX: env.DOCUMENT_SANDBOX,
  OSFO_DIRECTORY: env.OSFO_DIRECTORY,
});

/** Give the timer deadline ownership before the main instance can begin provider work. */
export const makeWorkflowPort = (
  main: WorkflowBinding,
  timer: WorkflowBinding,
): DocumentBuild.PortInterface["workflow"] => ({
  create: (mainId, timerId, payload) =>
    createWorkflowInstance(timer, timerId, payload).pipe(
      Effect.andThen(createWorkflowInstance(main, mainId, payload)),
    ),
  terminate: (mainId, timerId) =>
    Effect.all(
      [terminateWorkflowInstance(main, mainId), terminateWorkflowInstance(timer, timerId)],
      { concurrency: 2, discard: true },
    ),
});

/** Compose control-plane product truth over an existing request-scoped database. */
export const serviceLayerFromDatabase = (
  bindings: Pick<
    Bindings,
    | "ARTIFACTS"
    | "DOCUMENT_BUILD_TIMER_WORKFLOW"
    | "DOCUMENT_BUILD_WORKFLOW"
    | "DOCUMENT_SANDBOX"
    | "OSFO_DIRECTORY"
  >,
  database: Database,
  commitPreviewReadyFollowUp: DocumentBuild.PortInterface["commitPreviewReadyFollowUp"],
  commitTerminalFollowUp: DocumentBuild.PortInterface["commitTerminalFollowUp"],
) => {
  const port = DocumentBuild.Port.of({
    commitPreviewReadyFollowUp,
    commitTerminalFollowUp,
    currentAuthorization: DocumentBuildPostgres.makeCurrentAuthorization(database),
    discardPendingArtifact: makePendingArtifactDiscarder(
      bindings.ARTIFACTS,
      bindings.DOCUMENT_SANDBOX,
    ),
    files: makeFileResolver(bindings.OSFO_DIRECTORY),
    persistence: DocumentBuildPostgres.make(database),
    recordWorkflowStart: (build) =>
      makeAccounting(database)
        .recordWorkflowStart(build)
        .pipe(
          Effect.mapError((cause) => documentBuildUnavailable("accounting.workflowStart", cause)),
        ),
    workflow: makeWorkflowPort(
      bindings.DOCUMENT_BUILD_WORKFLOW,
      bindings.DOCUMENT_BUILD_TIMER_WORKFLOW,
    ),
  });
  return DocumentBuild.layerWithoutDependencies.pipe(
    Layer.provide(Layer.succeed(DocumentBuild.Port, port)),
  );
};

/** Run one main/timer Workflow callback with fresh PostgreSQL and product services. */
export const executionEffect = <Value, Failure>(
  env: Bindings,
  commitPreviewReadyFollowUp: DocumentBuild.PortInterface["commitPreviewReadyFollowUp"],
  commitTerminalFollowUp: DocumentBuild.PortInterface["commitTerminalFollowUp"],
  effect: Effect.Effect<Value, Failure, DocumentBuild.Service | DocumentBuildDocument.Service>,
) =>
  Effect.scoped(
    Db.database.pipe(
      Effect.flatMap((database) => {
        const buildLayer = serviceLayerFromDatabase(
          env,
          database,
          commitPreviewReadyFollowUp,
          commitTerminalFollowUp,
        );
        return DocumentBuild.Service.pipe(
          Effect.flatMap((builds) =>
            Effect.promise(() => import("../integrations/cloudflare/document-compute")).pipe(
              Effect.flatMap(({ DocumentCompute }) => {
                const documentPort = DocumentBuildDocument.Port.of({
                  artifacts: DocumentArtifacts.make(env.ARTIFACTS),
                  authorize: (build) =>
                    builds
                      .artifactAuthorization(
                        payloadFor(build),
                        maximumDocumentBuildComputeUsdMicros,
                      )
                      .pipe(Effect.map(({ build: authorized }) => authorized)),
                  commitAccounting: (build, contentId, cost) =>
                    builds.commitAccounting(payloadFor(build), contentId, cost),
                  commitPublication: (build, contentId) =>
                    builds.commitPublication(payloadFor(build), contentId),
                  compute: DocumentCompute.make(
                    env.DOCUMENT_SANDBOX,
                    env.ARTIFACTS,
                    maximumDocumentBuildComputeUsdMicros,
                  ),
                  finishSuccess: (build, contentId) =>
                    builds.finishSuccess(payloadFor(build), contentId),
                  markPreviewStored: (build, contentId) =>
                    builds.markPreviewStored(payloadFor(build), contentId),
                  maximumComputeUsdMicros: maximumDocumentBuildComputeUsdMicros,
                  recordGeneratedDocument: (build, artifact, cost) =>
                    makeAccounting(database)
                      .recordGeneratedDocument(build, artifact, cost)
                      .pipe(Effect.mapError(documentAccountingUnavailable)),
                  recordProviderCost: (build, contentId, cost) =>
                    builds
                      .recordProviderCost(payloadFor(build), contentId, cost)
                      .pipe(Effect.asVoid, Effect.mapError(documentAccountingUnavailable)),
                  validator: DocumentArtifactValidation,
                });
                const documentLayer = DocumentBuildDocument.layerWithoutDependencies.pipe(
                  Layer.provide(Layer.succeed(DocumentBuildDocument.Port, documentPort)),
                );
                return effect.pipe(
                  Effect.provide(
                    Layer.merge(documentLayer, Layer.succeed(DocumentBuild.Service, builds)),
                  ),
                );
              }),
            ),
          ),
          Effect.provide(buildLayer),
        );
      }),
      Effect.provide(Db.layer({ db: env.DB })),
    ),
  );

/** Run authenticated Agent start/inspect/cancel operations. */
export const controlEffect = <Value, Failure>(
  env: Pick<
    Bindings,
    | "ARTIFACTS"
    | "DB"
    | "DOCUMENT_BUILD_TIMER_WORKFLOW"
    | "DOCUMENT_BUILD_WORKFLOW"
    | "DOCUMENT_SANDBOX"
    | "OSFO_DIRECTORY"
  >,
  commitPreviewReadyFollowUp: DocumentBuild.PortInterface["commitPreviewReadyFollowUp"],
  commitTerminalFollowUp: DocumentBuild.PortInterface["commitTerminalFollowUp"],
  effect: Effect.Effect<Value, Failure, DocumentBuild.Service>,
) =>
  Effect.scoped(
    Db.database.pipe(
      Effect.flatMap((database) =>
        effect.pipe(
          Effect.provide(
            serviceLayerFromDatabase(
              env,
              database,
              commitPreviewReadyFollowUp,
              commitTerminalFollowUp,
            ),
          ),
        ),
      ),
      Effect.provide(Db.layer({ db: env.DB })),
    ),
  );

/** Run PostgreSQL notification claims with the same product clock as the Workflow host. */
export const followUpEffect = <Value, Error>(
  env: Pick<Bindings, "DB">,
  effect: Effect.Effect<Value, Error, DocumentBuildFollowUp.Service>,
) =>
  Effect.scoped(
    Db.database.pipe(
      Effect.flatMap((database) =>
        effect.pipe(
          Effect.provide(
            DocumentBuildFollowUp.layerWithoutDependencies.pipe(
              Layer.provide(
                Layer.succeed(
                  DocumentBuildFollowUp.Port,
                  DocumentBuildFollowUpPostgres.make(database),
                ),
              ),
            ),
          ),
        ),
      ),
      Effect.provide(Db.layer({ db: env.DB })),
    ),
  );

export const followUpLayerFromDatabase = (database: Database) =>
  DocumentBuildFollowUp.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.succeed(DocumentBuildFollowUp.Port, DocumentBuildFollowUpPostgres.make(database)),
    ),
  );

/** Compose the request-scoped safe notification projection from the shared database. */
export const followUpLayer = Layer.unwrap(Db.database.pipe(Effect.map(followUpLayerFromDatabase)));

/** Claim product truth first, then submit the one opaque notification to its owning Agent. */
export const makeTerminalFollowUpCommitter = (
  env: Pick<Bindings, "DB" | "OSFO_DIRECTORY">,
): DocumentBuild.PortInterface["commitTerminalFollowUp"] =>
  Effect.fn("DocumentBuildComposition.commitTerminalFollowUp")(function* (build) {
    const payload = payloadFor(build);
    const claimed = yield* followUpEffect(
      env,
      DocumentBuildFollowUp.Service.pipe(
        Effect.flatMap((followUps) => followUps.claimTerminal(payload)),
      ),
    ).pipe(Effect.mapError((cause) => documentBuildUnavailable("followUp.claimTerminal", cause)));
    if (claimed._tag === "NotTerminal" || claimed._tag === "Suppressed") return;
    const result = yield* submitFollowUp(env, claimed.notification.notificationId);
    if (result._tag !== "Accepted" && result._tag !== "Replayed") {
      return yield* documentBuildUnavailable("followUp.submit", result._tag);
    }
  });

/** Main-host boundary for a late preview; the timer remains the independent fallback. */
export const makePreviewReadyFollowUpCommitter = (
  env: Pick<Bindings, "DB" | "OSFO_DIRECTORY">,
): DocumentBuild.PortInterface["commitPreviewReadyFollowUp"] =>
  Effect.fn("DocumentBuildComposition.commitPreviewReadyFollowUp")(function* (build) {
    const claimed = yield* followUpEffect(
      env,
      DocumentBuildFollowUp.Service.pipe(
        Effect.flatMap((followUps) => followUps.claimPreview(payloadFor(build))),
      ),
    ).pipe(Effect.mapError((cause) => documentBuildUnavailable("followUp.claimPreview", cause)));
    if (claimed._tag !== "Claimed" && claimed._tag !== "AlreadyClaimed") return;
    if (claimed.notification === null) return;
    const claimedNotification = claimed.notification;
    const notification = yield* followUpEffect(
      env,
      DocumentBuildFollowUp.Service.pipe(
        Effect.flatMap((followUps) => followUps.inspect(claimedNotification.notificationId)),
      ),
    ).pipe(Effect.mapError((cause) => documentBuildUnavailable("followUp.inspectPreview", cause)));
    if (notification === null) {
      return yield* documentBuildUnavailable(
        "followUp.inspectPreview",
        claimedNotification.notificationId,
      );
    }
    if (DocumentBuildFollowUp.previewSubmissionDisposition(notification) === "PromoteTerminal") {
      return yield* makeTerminalFollowUpCommitter(env)(build);
    }
    const result = yield* submitFollowUp(env, notification.notificationId);
    if (result._tag === "TerminalSuperseded") {
      return yield* makeTerminalFollowUpCommitter(env)(build);
    }
  });

export const submitFollowUp = (
  env: Pick<Bindings, "OSFO_DIRECTORY">,
  notificationId: DocumentBuildFollowUp.NotificationId,
) =>
  Effect.gen(function* () {
    const untrusted = yield* Effect.tryPromise({
      try: () =>
        env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME).submitDocumentBuildFollowUp(
          notificationId,
        ),
      catch: (cause) => documentBuildUnavailable("followUp.directory", cause),
    });
    const result = yield* Schema.decodeUnknownEffect(DocumentBuildFollowUp.SubmissionSuccess)(
      untrusted,
    ).pipe(Effect.mapError((cause) => documentBuildUnavailable("followUp.decode", cause)));
    if (result.notificationId !== notificationId) {
      return yield* documentBuildUnavailable("followUp.identity", notificationId);
    }
    return result;
  });

export const makeFileResolver = (
  directory: DirectoryBinding,
): DocumentBuild.PortInterface["files"] => ({
  resolve: (agentId, userId, fileIds) =>
    Effect.gen(function* () {
      const untrusted = yield* Effect.tryPromise({
        try: () =>
          directory
            .getByName(OSFO_DIRECTORY_NAME)
            .resolveDocumentBuildFiles({ agentId, fileIds, userId }),
        catch: (cause) => documentBuildUnavailable("files.resolve", cause),
      });
      const result = yield* Schema.decodeUnknownEffect(
        Schema.toType(DocumentBuild.FileResolutionResult),
      )(untrusted).pipe(
        Effect.mapError((cause) => documentBuildUnavailable("files.resolve.decode", cause)),
      );
      if (result._tag === "Resolved") {
        const exactIdentity =
          result.files.length === fileIds.length &&
          result.files.every((file, index) => file.fileId === fileIds[index]);
        if (!exactIdentity) {
          return yield* documentBuildUnavailable("files.resolve.identity", {
            requested: fileIds,
            returned: result.files.map(({ fileId }) => fileId),
          });
        }
        return result.files;
      }
      if (result.reason === "fileUnavailable") {
        return yield* new DocumentBuild.SourceChanged({
          message: "A supplied file is missing, no longer ready, or no longer owned",
        });
      }
      return yield* documentBuildUnavailable(`files.resolve.${result.reason}`, result.reason);
    }),
});

const makeAccounting = (database: Database) =>
  DocumentBuildAccounting.make({
    recordLegacy: (allowancePeriodId, source, items) =>
      Allowances.make({
        billing: BillingDb.make(database),
        catalog: retainedCatalog,
        now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
      })
        .record(allowancePeriodId, source, items)
        .pipe(
          Effect.asVoid,
          Effect.mapError((cause) => new DocumentBuildAccounting.PersistenceUnavailable({ cause })),
        ),
    recordUsageEvent: (event) =>
      BillingDb.make(database)
        .recordUsageEvent(event)
        .pipe(
          Effect.asVoid,
          Effect.mapError((cause) => new DocumentBuildAccounting.PersistenceUnavailable({ cause })),
        ),
  });

const makePendingArtifactDiscarder = (
  bucket: R2Bucket,
  sandbox: Env["DOCUMENT_SANDBOX"],
): DocumentBuild.PortInterface["discardPendingArtifact"] =>
  Effect.fn("DocumentBuildComposition.discardPendingArtifact")(function* (build) {
    const contentId = ContentId.make(`document:workflow:${build.workflowId}`);
    const artifacts = DocumentArtifacts.make(bucket);
    const { DocumentCompute } = yield* Effect.promise(
      () => import("../integrations/cloudflare/document-compute"),
    );
    yield* discardPendingArtifact(build, {
      deleteArtifactBytes: (retained) =>
        DocumentArtifacts.deletePendingBytes(bucket, retained.artifact.content.contentId).pipe(
          Effect.mapError((cause) => documentBuildUnavailable("artifact.discard.delete", cause)),
        ),
      settleAttempt: () =>
        DocumentCompute.settleAttemptEvidenceForTerminalCleanup(
          bucket,
          contentId,
          build.userId,
        ).pipe(
          Effect.mapError((cause) => documentBuildUnavailable("artifact.discard.attempt", cause)),
        ),
      dispose: () =>
        DocumentCompute.make(sandbox, bucket, maximumDocumentBuildComputeUsdMicros)
          .dispose(contentId)
          .pipe(
            Effect.mapError((cause) => documentBuildUnavailable("artifact.discard.sandbox", cause)),
          ),
      inspectArtifact: () =>
        artifacts
          .inspect(contentId)
          .pipe(
            Effect.mapError((cause) => documentBuildUnavailable("artifact.discard.inspect", cause)),
          ),
    });
  });

interface PendingArtifactCleanupPorts {
  readonly deleteArtifactBytes: (
    artifact: StoredArtifactMetadata,
  ) => Effect.Effect<void, DocumentBuild.Unavailable>;
  readonly settleAttempt: () => Effect.Effect<"discarded" | "preserved", DocumentBuild.Unavailable>;
  readonly dispose: () => Effect.Effect<void, DocumentBuild.Unavailable>;
  readonly inspectArtifact: () => Effect.Effect<
    StoredArtifactMetadata | null,
    DocumentBuild.Unavailable
  >;
}

/** Settle deterministic pending storage even when PostgreSQL missed the preview marker. */
export const discardPendingArtifact = Effect.fn(
  "DocumentBuildComposition.discardPendingArtifactEvidence",
)(function* (
  build: Pick<DocumentBuild.Record, "userId" | "workflowId">,
  ports: PendingArtifactCleanupPorts,
) {
  const retained = yield* ports.inspectArtifact();
  const owner = DocumentArtifact.DocumentOwner.make({
    _tag: "Workflow",
    workflowId: build.workflowId,
  });
  if (
    retained !== null &&
    (retained.userId !== build.userId || !DocumentArtifact.sameOwner(retained.owner, owner))
  ) {
    return yield* documentBuildUnavailable("artifact.discard.identity", retained.owner);
  }
  yield* ports.dispose();
  yield* ports.settleAttempt();
  if (retained !== null) yield* ports.deleteArtifactBytes(retained);
});

const createWorkflowInstance = (
  binding: WorkflowBinding,
  instanceId: DocumentBuild.CloudflareInstanceId,
  payload: DocumentBuild.WorkflowPayload,
) =>
  Effect.tryPromise({
    try: () => binding.create({ id: instanceId, params: payload }).then(() => undefined),
    catch: (cause) => documentBuildUnavailable("workflow.create", cause),
  }).pipe(
    Effect.catchTag("DocumentBuildUnavailable", (failure) =>
      Effect.tryPromise({
        try: async () => {
          const instance = await binding.get(instanceId);
          return { instance, status: await instance.status() };
        },
        catch: (cause) => documentBuildUnavailable("workflow.reconcileCreate", cause),
      }).pipe(
        Effect.flatMap(({ instance, status }) => {
          if (status.status === "unknown") return Effect.fail(failure);
          if (
            status.status !== "errored" &&
            status.status !== "terminated" &&
            status.status !== "complete"
          ) {
            return Effect.void;
          }
          return Effect.tryPromise({
            try: () => instance.restart(),
            catch: (cause) => documentBuildUnavailable("workflow.restart", cause),
          });
        }),
      ),
    ),
  );

const terminateWorkflowInstance = (binding: WorkflowBinding, instanceId: string) =>
  Effect.tryPromise({
    try: async () => {
      const instance = await binding.get(instanceId);
      const status = await instance.status();
      if (
        status.status === "complete" ||
        status.status === "errored" ||
        status.status === "terminated" ||
        status.status === "unknown"
      ) {
        return;
      }
      await instance.terminate();
    },
    catch: (cause) => documentBuildUnavailable("workflow.terminate", cause),
  });

const payloadFor = (build: DocumentBuild.Record) =>
  DocumentBuild.WorkflowPayload.make({
    inputDigest: build.inputDigest,
    workflowId: build.workflowId,
  });

const documentBuildUnavailable = (operation: string, cause: unknown) =>
  new DocumentBuild.Unavailable({
    cause,
    message: "A Document Build dependency is unavailable",
    operation,
  });

const documentAccountingUnavailable = (cause: unknown) =>
  new DocumentBuildDocument.Unavailable({
    cause,
    message: "Document Build accounting could not be committed",
    operation: "accounting",
    reason: "storageUnavailable",
  });

export * as DocumentBuildComposition from "./document-build";
