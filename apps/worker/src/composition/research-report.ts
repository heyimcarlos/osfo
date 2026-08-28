import { Effect, Layer } from "effect";

import type { Database } from "@osfo/db";
import type { CloudflareEnv } from "../config";
import { Db } from "../db";
import { ResearchSourceEvidence } from "../integrations/cloudflare/research-source-evidence";
import {
  hasRecognizedWebSearchPrice,
  makeDiscovery,
  makePageFetch,
} from "../integrations/cloudflare/web";
import { ResearchCollectorPostgres } from "../integrations/postgres/research-collector";
import { ResearchReportPostgres } from "../integrations/postgres/research-report";
import { ResearchCollector } from "../services/research-collector";
import { ResearchReport } from "../services/research-report";

/* oxlint-disable effecttsgo/async-function -- Cloudflare Workflow bindings expose Promise-only handles. */
/* oxlint-disable effecttsgo/strict-effect-provide -- executionEffect is the Cloudflare Workflow invocation entry point. */

type WorkflowInstanceHandle = Pick<WorkflowInstance, "status" | "terminate">;

interface WorkflowBinding {
  readonly create: (options: {
    readonly id: string;
    readonly params: ResearchReport.WorkflowPayload;
  }) => Promise<WorkflowInstanceHandle>;
  readonly get: (id: string) => Promise<WorkflowInstanceHandle>;
}

export interface Bindings {
  readonly DB: Pick<Hyperdrive, "connectionString">;
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
  effect: Effect.Effect<Value, never, ResearchCollector.Service | ResearchReport.Service>,
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
      return yield* effect.pipe(
        Effect.provide(collectorLayer),
        Effect.provideService(ResearchReport.Service, reports),
      );
    }).pipe(Effect.provide(reportLayer));
  }).pipe(Effect.provide(Db.layer({ db: env.DB })));
  return Effect.scoped(program);
};

/** Narrow helper for tests that already own a Drizzle database. */
export const serviceLayerFromDatabase = (binding: WorkflowBinding, database: Database) =>
  serviceLayer(binding).pipe(Layer.provide(Db.layerFromDatabase(database)));

/** Cloudflare bindings are structurally narrowed before product composition. */
export const bindingsFromEnv = (env: CloudflareEnv): Bindings => ({
  DB: env.DB,
  FILES: env.FILES,
  RESEARCH_REPORT_WORKFLOW: env.RESEARCH_REPORT_WORKFLOW,
  WEBSEARCH: env.WEBSEARCH,
});

export * as ResearchReportComposition from "./research-report";
