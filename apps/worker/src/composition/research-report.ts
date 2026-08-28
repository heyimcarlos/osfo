import { DateTime, Effect, Layer } from "effect";

import type { Database } from "@osfo/db";
import type { CloudflareEnv } from "../config";
import { Db } from "../db";
import { BillingDb } from "../db/billing";
import { retainedCatalog } from "../domain/plan-policy";
import { DocumentArtifactValidation } from "../integrations/cloudflare/document-artifact-validation";
import { DocumentArtifacts } from "../integrations/cloudflare/document-artifacts";
import { ResearchSourceEvidence } from "../integrations/cloudflare/research-source-evidence";
import { ResearchSynthesisEvidence } from "../integrations/cloudflare/research-synthesis-evidence";
import { ResearchSynthesisProvider } from "../integrations/cloudflare/research-synthesis-provider";
import {
  hasRecognizedWebSearchPrice,
  makeDiscovery,
  makePageFetch,
} from "../integrations/cloudflare/web";
import { ResearchCollectorPostgres } from "../integrations/postgres/research-collector";
import { ResearchReportPostgres } from "../integrations/postgres/research-report";
import { ResearchSynthesisPostgres } from "../integrations/postgres/research-synthesis";
import { ResearchCollector } from "../services/research-collector";
import { Allowances } from "../services/allowances";
import { ResearchReportDocument } from "../services/research-report-document";
import { ResearchReport } from "../services/research-report";
import { ResearchReportAccounting } from "../services/research-report-accounting";
import { ResearchSynthesis } from "../services/research-synthesis";

/* oxlint-disable effecttsgo/async-function -- Cloudflare Workflow bindings expose Promise-only handles. */
/* oxlint-disable effecttsgo/strict-effect-provide -- executionEffect is the Cloudflare Workflow invocation entry point. */

type WorkflowInstanceHandle = Pick<WorkflowInstance, "status" | "terminate">;

const researchReportDocumentSandboxUsdMicros = 50_000n;

interface WorkflowBinding {
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
  readonly RESEARCH_REPORT_WORKFLOW: WorkflowBinding;
  readonly WEBSEARCH: Pick<WebSearch, "search">;
}

/** Cloudflare instance adapter that reconciles a lost create acknowledgement by stable ID. */
export const makeWorkflowPort = (
  binding: WorkflowBinding,
): ResearchReport.PortInterface["workflow"] => ({
  create: (instanceId, payload) =>
    Effect.tryPromise({
      try: () => binding.create({ id: instanceId, params: payload }).then(() => undefined),
      catch: (cause) =>
        new ResearchReport.Unavailable({
          cause,
          message: "Cloudflare did not acknowledge the Research Report Workflow instance",
          operation: "workflow.create",
        }),
    }).pipe(
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
    ),
  terminate: (instanceId) =>
    Effect.tryPromise({
      try: async () => {
        const instance = await binding.get(instanceId);
        const status = await instance.status();
        if (status.status === "unknown" || status.status === "terminated") return;
        await instance.terminate();
      },
      catch: (cause) =>
        new ResearchReport.Unavailable({
          cause,
          message: "Cloudflare could not interrupt the Research Report Workflow instance",
          operation: "workflow.terminate",
        }),
    }),
});

/** Compose one Research Report service with its dedicated persistence and Workflow ports. */
export const serviceLayer = (binding: WorkflowBinding) => {
  const portLayer = Layer.effect(
    ResearchReport.Port,
    Db.database.pipe(
      Effect.map((database) =>
        ResearchReport.Port.of({
          currentAuthorization: ResearchReportPostgres.makeCurrentAuthorization(database),
          persistence: ResearchReportPostgres.make(database),
          providerAvailable: Effect.succeed(hasRecognizedWebSearchPrice),
          recordWorkflowStart: makeWorkflowStartRecorder(database),
          workflow: makeWorkflowPort(binding),
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
    const reportLayer = serviceLayerFromDatabase(env.RESEARCH_REPORT_WORKFLOW, database);
    return yield* Effect.gen(function* () {
      const reports = yield* ResearchReport.Service;
      const collectorPort = ResearchCollector.Port.of({
        authorize: (report) =>
          reports.authorizeExecution(
            ResearchReport.WorkflowPayload.make({
              inputDigest: report.inputDigest,
              workflowId: report.workflowId,
            }),
          ),
        persistence: ResearchCollectorPostgres.make(database),
        provider: {
          discover: makeDiscovery(env.WEBSEARCH),
          fetchPage: makePageFetch(),
        },
        sourceEvidence: ResearchSourceEvidence.make(env.FILES),
      });
      const collectorLayer = ResearchCollector.layerWithoutDependencies.pipe(
        Layer.provide(Layer.succeed(ResearchCollector.Port, collectorPort)),
      );
      const synthesisPort = ResearchSynthesis.Port.of({
        authorize: collectorPort.authorize,
        evidence: ResearchSynthesisEvidence.make(env.FILES),
        persistence: ResearchSynthesisPostgres.make(database),
        provider: ResearchSynthesisProvider.make(env.AI),
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
        completeSuccess: (report, contentId) =>
          reports.completeSuccess(payloadFor(report), contentId),
        compute: DocumentCompute.make(
          env.DOCUMENT_SANDBOX,
          env.ARTIFACTS,
          researchReportDocumentSandboxUsdMicros,
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
export const serviceLayerFromDatabase = (binding: WorkflowBinding, database: Database) =>
  serviceLayer(binding).pipe(Layer.provide(Db.layerFromDatabase(database)));

/** Cloudflare bindings are structurally narrowed before product composition. */
export const bindingsFromEnv = (env: CloudflareEnv): Bindings => ({
  AI: env.AI,
  ARTIFACTS: env.ARTIFACTS,
  DB: env.DB,
  DOCUMENT_SANDBOX: env.DOCUMENT_SANDBOX,
  FILES: env.FILES,
  RESEARCH_REPORT_WORKFLOW: env.RESEARCH_REPORT_WORKFLOW,
  WEBSEARCH: env.WEBSEARCH,
});

const payloadFor = (report: ResearchReport.Record) =>
  ResearchReport.WorkflowPayload.make({
    inputDigest: report.inputDigest,
    workflowId: report.workflowId,
  });

const makeUsageRecorder =
  (database: Database): ResearchReportDocument.PortInterface["recordUsage"] =>
  (report, artifact, synthesisCost, renderCost) =>
    makeAccounting(database)
      .recordUsefulReport(report, artifact, synthesisCost, renderCost)
      .pipe(Effect.mapError(documentAccountingUnavailable));

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

const documentAccountingUnavailable = (cause: ResearchReportAccounting.Unavailable) =>
  new ResearchReportDocument.Unavailable({
    cause,
    message: cause.message,
    operation: "recordUsage",
    reason: "storageUnavailable",
  });

export * as ResearchReportComposition from "./research-report";
