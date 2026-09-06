import { DocumentAuthorizationUnavailable } from "../services/document-generation";
import { IncidentControlsPostgres } from "../integrations/postgres/incident-controls";
import { DateTime, Effect, Layer } from "effect";

import type { Database } from "@osfo/db";
import { loadConfig, type CloudflareEnv, type ResearchReportProviderConfig } from "../config";
import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { Db } from "../db";
import { BillingDb } from "../db/billing";
import { ContentId } from "../domain/client-content";
import { DocumentArtifact } from "../domain/document-artifact";
import { retainedCatalog } from "../domain/plan-policy";
import { DocumentArtifactValidation } from "../integrations/cloudflare/document-artifact-validation";
import { DocumentArtifacts } from "../integrations/cloudflare/document-artifacts";
import { ResearchSourceEvidence } from "../integrations/cloudflare/research-source-evidence";
import { ResearchSynthesisEvidence } from "../integrations/cloudflare/research-synthesis-evidence";
import { ResearchVerificationProvider } from "../integrations/cloudflare/research-verification-provider";
import { ResearchCollectorPostgres } from "../integrations/postgres/research-collector";
import { ResearchReportPostgres } from "../integrations/postgres/research-report";
import { ResearchReportFollowUpPostgres } from "../integrations/postgres/research-report-follow-up";
import { ResearchReportPublicationPostgres } from "../integrations/postgres/research-report-publication";
import { ResearchSynthesisPostgres } from "../integrations/postgres/research-synthesis";
import { ResearchCollector } from "../services/research-collector";
import type { IncidentControls } from "../services/incident-controls";
import { Allowances } from "../services/allowances";
import { ResearchReportDocument } from "../services/research-report-document";
import { ResearchReport } from "../services/research-report";
import { ResearchReportFollowUp } from "../services/research-report-follow-up";
import { ResearchReportAccounting } from "../services/research-report-accounting";
import { ResearchSynthesis } from "../services/research-synthesis";

/* oxlint-disable effecttsgo/async-function -- Cloudflare Workflow bindings expose Promise-only handles. */
/* oxlint-disable effecttsgo/strict-effect-provide -- executionEffect is the Cloudflare Workflow invocation entry point. */
/* oxlint-disable eslint/no-underscore-dangle -- Agent RPC and product outcomes use the canonical _tag discriminator. */

type WorkflowInstanceHandle = Pick<WorkflowInstance, "status" | "terminate">;

const researchReportDocumentSandboxUsdMicros = 50_000n;

export interface WorkflowBinding {
  readonly create: (options: {
    readonly id: string;
    readonly params: ResearchReport.WorkflowPayload;
  }) => Promise<WorkflowInstanceHandle>;
  readonly get: (id: string) => Promise<WorkflowInstanceHandle>;
}

export interface Bindings {
  readonly AI: Ai;
  readonly ARTIFACTS: R2Bucket;
  readonly DB: Pick<Hyperdrive, "connectionString">;
  readonly DOCUMENT_SANDBOX: Env["DOCUMENT_SANDBOX"];
  readonly FILES: R2Bucket;
  readonly OSFO_DIRECTORY: Env["OSFO_DIRECTORY"];
  readonly RESEARCH_REPORT_WORKFLOW: WorkflowBinding;
  readonly RESEARCH_REPORT_TIMER_WORKFLOW: WorkflowBinding;
  readonly researchReportProvider: ResearchReportProviderConfig;
  readonly WEBSEARCH: Pick<WebSearch, "search">;
}

/** Cloudflare instance adapter that reconciles a lost create acknowledgement by stable ID. */
export const makeWorkflowPort = (
  binding: WorkflowBinding,
  checkNewCreation: Effect.Effect<void, IncidentControls.Paused | IncidentControls.Unavailable>,
  timerBinding: WorkflowBinding = binding,
): ResearchReport.PortInterface["workflow"] => ({
  create: (instanceId, payload) =>
    Effect.all(
      [
        createWorkflowInstance(binding, instanceId, payload, checkNewCreation),
        createWorkflowInstance(
          timerBinding,
          timerInstanceId(instanceId),
          payload,
          checkNewCreation,
        ),
      ],
      { concurrency: 2, discard: true },
    ),
  terminate: (instanceId) =>
    Effect.all(
      [
        terminateWorkflowInstance(binding, instanceId),
        terminateWorkflowInstance(timerBinding, timerInstanceId(instanceId)),
      ],
      { concurrency: 2, discard: true },
    ),
});

const createWorkflowInstance = (
  binding: WorkflowBinding,
  instanceId: string,
  payload: ResearchReport.WorkflowPayload,
  checkNewCreation: Effect.Effect<void, IncidentControls.Paused | IncidentControls.Unavailable>,
) =>
  checkNewCreation.pipe(
    Effect.mapError(
      (cause) =>
        new ResearchReport.Unavailable({
          cause,
          message: "Research Report Workflow creation is unavailable",
          operation: "workflow.create",
        }),
    ),
    Effect.andThen(
      Effect.tryPromise({
        try: () => binding.create({ id: instanceId, params: payload }).then(() => undefined),
        catch: (cause) =>
          new ResearchReport.Unavailable({
            cause,
            message: "Cloudflare did not acknowledge the Research Report Workflow instance",
            operation: "workflow.create",
          }),
      }),
    ),
    Effect.catchTag("ResearchReportUnavailable", (failure) =>
      Effect.tryPromise({
        try: async () => {
          const instance = await binding.get(instanceId);
          return instance.status();
        },
        catch: (cause) =>
          new ResearchReport.Unavailable({
            cause,
            message: "Cloudflare could not reconcile the Research Report Workflow instance",
            operation: "workflow.reconcileCreate",
          }),
      }).pipe(
        Effect.flatMap((status) =>
          status.status === "unknown" ? Effect.fail(failure) : Effect.void,
        ),
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
    catch: (cause) =>
      new ResearchReport.Unavailable({
        cause,
        message: "Cloudflare could not interrupt the Research Report Workflow instance",
        operation: "workflow.terminate",
      }),
  });

const timerInstanceId = (instanceId: ResearchReport.CloudflareInstanceId) => `${instanceId}-timer`;

/** Compose one Research Report service with its dedicated persistence and Workflow ports. */
export const serviceLayer = (
  binding: WorkflowBinding,
  timerBinding: WorkflowBinding,
  commitTerminalFollowUp: ResearchReport.PortInterface["commitTerminalFollowUp"],
  artifacts: R2Bucket,
  providerAvailable = false,
) => {
  const portLayer = Layer.effect(
    ResearchReport.Port,
    Db.database.pipe(
      Effect.map((database) =>
        ResearchReport.Port.of({
          currentAuthorization: ResearchReportPostgres.makeCurrentAuthorization(database),
          commitTerminalFollowUp,
          discardPendingArtifact: makePendingArtifactDiscarder(artifacts),
          persistence: ResearchReportPostgres.make(database),
          providerAvailable: Effect.succeed(providerAvailable),
          recordWorkflowStart: makeWorkflowStartRecorder(database),
          workflow: makeWorkflowPort(
            binding,
            IncidentControlsPostgres.makeFromDatabase(database).check("newCostlyWork"),
            timerBinding,
          ),
        }),
      ),
    ),
  );
  return ResearchReport.layerWithoutDependencies.pipe(Layer.provide(portLayer));
};

/** Run one execution-host operation with a fresh Hyperdrive connection. */
export const executionEffect = <Value>(
  env: Bindings,
  effect: Effect.Effect<
    Value,
    never,
    | ResearchCollector.Service
    | ResearchReport.Service
    | ResearchReportDocument.Service
    | ResearchSynthesis.Service
  >,
) => {
  const program = Effect.gen(function* () {
    const database = yield* Db.database;
    const reportLayer = serviceLayerFromDatabase(
      env.RESEARCH_REPORT_WORKFLOW,
      database,
      env.RESEARCH_REPORT_TIMER_WORKFLOW,
      makeTerminalFollowUpCommitter(database, async (notificationId) => {
        const result =
          await env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME).submitResearchReportFollowUp(
            notificationId,
          );
        return result._tag;
      }),
      env.ARTIFACTS,
      ResearchVerificationProvider.isAvailable(env.researchReportProvider),
    );
    return yield* Effect.gen(function* () {
      const reports = yield* ResearchReport.Service;
      const collectorPort = ResearchCollector.Port.of({
        checkNewDispatch: IncidentControlsPostgres.makeFromDatabase(database)
          .check("newCostlyWork")
          .pipe(
            Effect.mapError(
              (cause) =>
                new ResearchCollector.Unavailable({
                  cause,
                  message: "New provider work is temporarily unavailable",
                  reason: "authorizationDenied",
                }),
            ),
          ),
        authorize: (report) =>
          reports.authorizeExecution(
            ResearchReport.WorkflowPayload.make({
              inputDigest: report.inputDigest,
              workflowId: report.workflowId,
            }),
          ),
        persistence: ResearchCollectorPostgres.make(database),
        provider: {
          managedSearch: env.researchReportProvider._tag === "ManagedWebSearch",
          discover: ResearchVerificationProvider.selectDiscovery(
            env.researchReportProvider,
            env.WEBSEARCH,
            env.AI,
          ),
          fetchPage: ResearchVerificationProvider.selectPageFetch(env.researchReportProvider),
        },
        sourceEvidence: ResearchSourceEvidence.make(env.FILES),
      });
      const collectorLayer = ResearchCollector.layerWithoutDependencies.pipe(
        Layer.provide(Layer.succeed(ResearchCollector.Port, collectorPort)),
      );
      const synthesisPort = ResearchSynthesis.Port.of({
        checkNewDispatch: IncidentControlsPostgres.makeFromDatabase(database)
          .check("newCostlyWork")
          .pipe(
            Effect.mapError(
              (cause) =>
                new ResearchSynthesis.Unavailable({
                  cause,
                  message: "New provider work is temporarily unavailable",
                  reason: "authorizationDenied",
                }),
            ),
          ),
        authorize: collectorPort.authorize,
        evidence: ResearchSynthesisEvidence.make(env.FILES),
        persistence: ResearchSynthesisPostgres.make(database),
        provider: ResearchVerificationProvider.selectSynthesis(env.researchReportProvider, env.AI),
        recordCompanyCost: makeSynthesisCostRecorder(database),
      });
      const synthesisLayer = ResearchSynthesis.layerWithoutDependencies.pipe(
        Layer.provide(Layer.succeed(ResearchSynthesis.Port, synthesisPort)),
      );
      const { DocumentCompute } = yield* Effect.promise(
        () => import("../integrations/cloudflare/document-compute"),
      );
      const documentPort = ResearchReportDocument.Port.of({
        artifacts: DocumentArtifacts.make(env.ARTIFACTS),
        authorize: (report) =>
          reports.artifactAuthorization(payloadFor(report), researchReportDocumentSandboxUsdMicros),
        claimPublication: (report, contentId) =>
          reports.claimArtifactPublication(payloadFor(report), contentId),
        commitPublication: (report, contentId) =>
          reports.commitArtifactPublication(payloadFor(report), contentId),
        compute: DocumentCompute.make(
          env.DOCUMENT_SANDBOX,
          env.ARTIFACTS,
          researchReportDocumentSandboxUsdMicros,
          IncidentControlsPostgres.makeFromDatabase(database)
            .check("newCostlyWork")
            .pipe(
              Effect.mapError(
                (cause) =>
                  new DocumentAuthorizationUnavailable({
                    cause,
                    message: "New document rendering is temporarily unavailable",
                  }),
              ),
            ),
        ),
        maximumComputeUsdMicros: researchReportDocumentSandboxUsdMicros,
        recordRenderCost: makeRenderCostRecorder(database),
        recordUsage: makeUsageRecorder(database),
        validator: DocumentArtifactValidation,
      });
      const documentLayer = ResearchReportDocument.layerWithoutDependencies.pipe(
        Layer.provide(Layer.succeed(ResearchReportDocument.Port, documentPort)),
        Layer.provide(collectorLayer),
        Layer.provide(synthesisLayer),
      );
      const executionLayer = Layer.mergeAll(
        collectorLayer,
        synthesisLayer,
        documentLayer,
        Layer.succeed(ResearchReport.Service, reports),
      );
      return yield* effect.pipe(Effect.provide(executionLayer));
    }).pipe(Effect.provide(reportLayer));
  }).pipe(Effect.provide(Db.layer({ db: env.DB })));
  return Effect.scoped(program);
};

/** Narrow helper for tests that already own a Drizzle database. */
export const serviceLayerFromDatabase = (
  binding: WorkflowBinding,
  database: Database,
  timerBinding: WorkflowBinding,
  commitTerminalFollowUp: ResearchReport.PortInterface["commitTerminalFollowUp"],
  artifacts: R2Bucket,
  providerAvailable = false,
) =>
  serviceLayer(binding, timerBinding, commitTerminalFollowUp, artifacts, providerAvailable).pipe(
    Layer.provide(Db.layerFromDatabase(database)),
  );

/** Compose PostgreSQL milestone, deadline, and follow-up claims for either Workflow host. */
export const followUpLayerFromDatabase = (database: Database) =>
  ResearchReportFollowUp.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.succeed(ResearchReportFollowUp.Port, ResearchReportFollowUpPostgres.make(database)),
    ),
  );

/** Compose the request-scoped Research Report follow-up service from the shared database. */
export const followUpLayer = Layer.unwrap(Db.database.pipe(Effect.map(followUpLayerFromDatabase)));

/** Run one lightweight timer or notification operation with a fresh Hyperdrive connection. */
export const followUpEffect = <Value>(
  env: Pick<Bindings, "DB">,
  effect: Effect.Effect<Value, never, ResearchReportFollowUp.Service>,
) =>
  Effect.scoped(
    Db.database.pipe(
      Effect.flatMap((database) =>
        effect.pipe(Effect.provide(followUpLayerFromDatabase(database))),
      ),
      Effect.provide(Db.layer({ db: env.DB })),
    ),
  );

/** Run one authenticated Agent control operation against the dedicated service. */
export const controlEffect = <Value, Failure>(
  env: Bindings,
  submit: (notificationId: ResearchReportFollowUp.NotificationId) => Promise<string>,
  effect: Effect.Effect<Value, Failure, ResearchReport.Service>,
) =>
  Effect.scoped(
    Db.database.pipe(
      Effect.flatMap((database) =>
        effect.pipe(
          Effect.provide(
            serviceLayerFromDatabase(
              env.RESEARCH_REPORT_WORKFLOW,
              database,
              env.RESEARCH_REPORT_TIMER_WORKFLOW,
              makeTerminalFollowUpCommitter(database, submit),
              env.ARTIFACTS,
              ResearchVerificationProvider.isAvailable(env.researchReportProvider),
            ),
          ),
        ),
      ),
      Effect.provide(Db.layer({ db: env.DB })),
    ),
  );

/** Cloudflare bindings are structurally narrowed before product composition. */
export const bindingsFromEnv = (env: CloudflareEnv): Bindings => ({
  AI: env.AI,
  ARTIFACTS: env.ARTIFACTS,
  DB: env.DB,
  DOCUMENT_SANDBOX: env.DOCUMENT_SANDBOX,
  FILES: env.FILES,
  OSFO_DIRECTORY: env.OSFO_DIRECTORY,
  RESEARCH_REPORT_WORKFLOW: env.RESEARCH_REPORT_WORKFLOW,
  RESEARCH_REPORT_TIMER_WORKFLOW: env.RESEARCH_REPORT_TIMER_WORKFLOW,
  researchReportProvider: loadConfig(env).researchReportProvider,
  WEBSEARCH: env.WEBSEARCH,
});

const payloadFor = (report: ResearchReport.Record) =>
  ResearchReport.WorkflowPayload.make({
    inputDigest: report.inputDigest,
    workflowId: report.workflowId,
  });

const makeTerminalFollowUpCommitter =
  (
    database: Database,
    submit: (notificationId: ResearchReportFollowUp.NotificationId) => Promise<string>,
  ): ResearchReport.PortInterface["commitTerminalFollowUp"] =>
  (report) =>
    Effect.gen(function* () {
      const payload = payloadFor(report);
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
      const claimed = yield* ResearchReportFollowUpPostgres.make(database)
        .claimTerminal(payload, now)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ResearchReport.Unavailable({
                cause,
                message: "The terminal Research Report follow-up could not be claimed",
                operation: "followUp.claimTerminal",
              }),
          ),
        );
      if (claimed._tag === "Suppressed") return undefined;
      if (claimed._tag === "NotTerminal") {
        return yield* new ResearchReport.Unavailable({
          cause: report.state,
          message: "The terminal Research Report follow-up lost its product outcome",
          operation: "followUp.claimTerminal",
        });
      }
      const result = yield* Effect.tryPromise({
        try: () => submit(claimed.notification.notificationId),
        catch: (cause) =>
          new ResearchReport.Unavailable({
            cause,
            message: "The terminal Research Report follow-up could not reach its Agent",
            operation: "followUp.submit",
          }),
      });
      if (result !== "Accepted" && result !== "Replayed") {
        return yield* new ResearchReport.Unavailable({
          cause: result,
          message: "The terminal Research Report follow-up was not accepted by its Agent",
          operation: "followUp.submit",
        });
      }
      return undefined;
    }).pipe(Effect.asVoid);

const makeUsageRecorder =
  (database: Database): ResearchReportDocument.PortInterface["recordUsage"] =>
  (report, artifact, synthesisCost, renderCost) =>
    Effect.gen(function* () {
      const accounting = yield* ResearchReportAccounting.usefulReportAccountingFor(
        report,
        artifact,
        synthesisCost,
        renderCost,
      );
      const completedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
      return yield* ResearchReportPublicationPostgres.complete(database, {
        accounting,
        completedAt,
        contentId: artifact.content.contentId,
        report,
      });
    }).pipe(Effect.mapError(documentAccountingUnavailable));

const makeWorkflowStartRecorder =
  (database: Database): ResearchReport.PortInterface["recordWorkflowStart"] =>
  (report) =>
    makeAccounting(database)
      .recordWorkflowStart(report)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ResearchReport.Unavailable({
              cause,
              message: "The accepted Workflow start could not be retained",
              operation: "accounting.workflowStart",
            }),
        ),
      );

const makeAllowances = (database: Database) =>
  Allowances.make({
    billing: BillingDb.make(database),
    catalog: retainedCatalog,
    now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
  });

const makePendingArtifactDiscarder = (
  bucket: R2Bucket,
): ResearchReport.PortInterface["discardPendingArtifact"] =>
  Effect.fn("ResearchReportComposition.discardPendingArtifact")(function* (report) {
    if (report.artifactContentId === null) return;
    const contentId = ContentId.make(report.artifactContentId);
    const artifacts = DocumentArtifacts.make(bucket);
    const retained = yield* artifacts.inspect(contentId).pipe(
      Effect.mapError(
        (cause) =>
          new ResearchReport.Unavailable({
            cause,
            message: "The canceled Research Report artifact could not be inspected",
            operation: "artifact.discard.inspect",
          }),
      ),
    );
    if (retained === null) return;
    const owner = DocumentArtifact.DocumentOwner.make({
      _tag: "Workflow",
      workflowId: report.workflowId,
    });
    if (retained.userId !== report.userId || !DocumentArtifact.sameOwner(retained.owner, owner)) {
      // oxlint-disable-next-line typescript/consistent-return -- The typed failure is a definitive generator exit.
      return yield* new ResearchReport.Unavailable({
        cause: retained.owner,
        message: "The canceled Research Report artifact owns different immutable facts",
        operation: "artifact.discard.identity",
      });
    }
    yield* artifacts.delete(retained).pipe(
      Effect.mapError(
        (cause) =>
          new ResearchReport.Unavailable({
            cause,
            message: "The canceled Research Report artifact could not be removed",
            operation: "artifact.discard.delete",
          }),
      ),
    );
  });

const makeSynthesisCostRecorder =
  (database: Database): ResearchSynthesis.PortInterface["recordCompanyCost"] =>
  (report, cost) =>
    makeAccounting(database)
      .recordSynthesisCost(report, cost)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ResearchSynthesis.Unavailable({
              cause,
              message: "Synthesis Company Cost could not be retained",
              reason: "storageUnavailable",
            }),
        ),
      );

const makeRenderCostRecorder =
  (database: Database): ResearchReportDocument.PortInterface["recordRenderCost"] =>
  (report, cost) =>
    makeAccounting(database)
      .recordRenderCost(report, cost)
      .pipe(Effect.mapError(documentAccountingUnavailable));

const makeAccounting = (database: Database) =>
  ResearchReportAccounting.make({
    recordLegacy: (allowancePeriodId, source, items) =>
      makeAllowances(database)
        .record(allowancePeriodId, source, items)
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) => new ResearchReportAccounting.PersistenceUnavailable({ cause }),
          ),
        ),
    recordUsageEvent: (event) =>
      BillingDb.make(database)
        .recordUsageEvent(event)
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) => new ResearchReportAccounting.PersistenceUnavailable({ cause }),
          ),
        ),
  });

const documentAccountingUnavailable = (cause: unknown) =>
  new ResearchReportDocument.Unavailable({
    cause,
    message: "Useful Research Report accounting could not be committed",
    operation: "recordUsage",
    reason: "storageUnavailable",
  });

export * as ResearchReportComposition from "./research-report";
