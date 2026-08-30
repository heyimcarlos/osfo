import { Redacted, Schema } from "effect";
import { getAgentByName } from "agents";
import { ContainerProxy, Sandbox } from "@cloudflare/sandbox";
import { WorkerEntrypoint } from "cloudflare:workers";

import { App } from "./app";
import { OSFO_DIRECTORY_NAME } from "./agents/osfo/directory";
import { loadConfig, WorkerConfigurationError, type CloudflareEnv } from "./config";
import { DocumentCostReconciliation } from "./document-cost-reconciliation";
import { DocumentBuildHostReconciliation } from "./document-build-host-reconciliation";
import { ScheduledEmailReconciliation } from "./scheduled-email-reconciliation";
import { makeWhatsAppAdapter } from "./integrations/whatsapp";
import { WhatsAppWakeUpComposition } from "./composition/whatsapp-wakeups";
import {
  runQualificationTrigger,
  sameQualificationTriggerSecret,
} from "./integrations/cloudflare/qualification-trigger";
import { qualificationExecutionListingBucket } from "./integrations/cloudflare/qualification-execution-artifacts";
import { scheduledRunKind, settleScheduledBranches } from "./scheduled-lifecycle";
import { handleQualificationProductAuthority } from "./qualification-product-authority-worker";
import { runQualificationCohortProvisioner } from "./qualification-cohort-provisioner";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Cloudflare RPC tags and adapter boundaries require these forms. */

export { OsfoAgent } from "./agents/osfo/agent";
export { CompanyAgent } from "./agents/osfo/company-agent";
export { OsfoDirectory } from "./agents/osfo/directory";
export { QualificationCohortArtifactAuthority } from "./qualification-cohort-artifact-authority";
export { ThinkMessengerStateAgent } from "@cloudflare/think/messengers";
export { ExecutionUnitWorkflow } from "./workflows/runtime";
export { DocumentBuildWorkflow } from "./workflows/document-build";
export { DocumentBuildTimerWorkflow } from "./workflows/document-build-timer";
export { ResearchReportWorkflow } from "./workflows/research-report";
export { ResearchReportTimerWorkflow } from "./workflows/research-report-timer";
export { ScheduledEmailWorkflow } from "./workflows/scheduled-email";
export { QualificationCohortScrubPartitionWorkflow } from "./workflows/qualification-cohort-scrub-partition";
export { runProductionQualification } from "./integrations/cloudflare/production-qualification";

/** Private product-owned qualification authority entrypoint. */
export class QualificationProductAuthority extends WorkerEntrypoint<CloudflareEnv> {
  override fetch(request: Request): Promise<Response> {
    return handleQualificationProductAuthority(request, this.env);
  }
}
/** Disposable artifact compute has no direct public-network path or injected credentials. */
class ArtifactSandbox extends Sandbox {
  override enableInternet = false;
  override envVars: Record<string, string> = {};
}

export { ArtifactSandbox as Sandbox, ContainerProxy };

/** Osfo Cloudflare Worker host. */
const worker = {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/webhooks/telegram") {
      const directory = await getAgentByName(env.OSFO_DIRECTORY, OSFO_DIRECTORY_NAME);
      return directory.fetch(request);
    }
    if (path === "/webhooks/whatsapp" && request.method === "POST") {
      const directory = await getAgentByName(env.OSFO_DIRECTORY, OSFO_DIRECTORY_NAME);
      return directory.fetch(request);
    }
    if (path === "/webhooks/whatsapp" && request.method === "GET") {
      try {
        const config = loadConfig(env).whatsApp;
        return makeWhatsAppAdapter({
          accessToken: Redacted.value(config.accessToken),
          apiUrl: config.apiBaseURL,
          appSecret: Redacted.value(config.appSecret),
          phoneNumberId: config.phoneNumberId,
          userName: config.botUsername,
          verifyToken: Redacted.value(config.verifyToken),
        }).handleWebhook(request);
      } catch (error) {
        if (Schema.is(WorkerConfigurationError)(error)) {
          logConfigurationError(error);
          return environmentErrorResponse();
        }
        throw error;
      }
    }
    if (path === "/internal/qualification-executions" && request.method === "POST") {
      return runQualificationTrigger(request, {
        ARTIFACTS: qualificationExecutionListingBucket(env.ARTIFACTS),
        CF_VERSION_METADATA: env.CF_VERSION_METADATA,
        QUALIFICATION_OWNER: env.QUALIFICATION_OWNER,
        QUALIFICATION_TRIGGER_TOKEN: env.QUALIFICATION_TRIGGER_TOKEN,
      });
    }
    if (path === "/internal/qualification-cohorts" && request.method === "POST") {
      const token = env.QUALIFICATION_TRIGGER_TOKEN;
      const version = env.CF_VERSION_METADATA;
      if (token === undefined || version === undefined) {
        return Response.json({ error: "qualificationProvisionerUnavailable" }, { status: 503 });
      }
      if (
        !(await sameQualificationTriggerSecret(
          request.headers.get("authorization") ?? "",
          `Bearer ${token}`,
        ))
      ) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const config = loadConfig(env);
      const qualificationEmailFields =
        env.QUALIFICATION_EMAIL_RECIPIENT === undefined
          ? {}
          : { QUALIFICATION_EMAIL_RECIPIENT: env.QUALIFICATION_EMAIL_RECIPIENT };
      const qualificationArtifactAuthorityFields =
        env.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY === undefined
          ? {}
          : {
              QUALIFICATION_COHORT_ARTIFACT_AUTHORITY: env.QUALIFICATION_COHORT_ARTIFACT_AUTHORITY,
            };
      return runQualificationCohortProvisioner(request, version.id, config.auth.secret, {
        ARTIFACTS: env.ARTIFACTS,
        DB: env.DB,
        OSFO_DIRECTORY: env.OSFO_DIRECTORY,
        ...qualificationArtifactAuthorityFields,
        ...qualificationEmailFields,
      });
    }
    let app: Awaited<ReturnType<typeof App.makeCloudflareApp>>;
    try {
      app = await App.makeCloudflareApp(env);
    } catch (error) {
      if (Schema.is(WorkerConfigurationError)(error)) {
        logConfigurationError(error);
        return environmentErrorResponse();
      }
      throw error;
    }
    return fetchApp(request, app);
  },
  scheduled(controller: ScheduledController, env: CloudflareEnv, context: ExecutionContext): void {
    try {
      if (scheduledRunKind(controller.cron) === "scheduledEmailReconciliation") {
        context.waitUntil(ScheduledEmailReconciliation.run(env));
        return;
      }
      if (scheduledRunKind(controller.cron) !== "hourlyMaintenance") return;
      const config = loadConfig(env);
      context.waitUntil(
        settleScheduledBranches([
          () => App.expireChannelLinkInvites(env).then(() => undefined),
          () => App.reconcileAccountDeletions(env).then(() => undefined),
          () => DocumentBuildHostReconciliation.run(env).then(() => undefined),
          () => DocumentCostReconciliation.run(env).then(() => undefined),
          () => WhatsAppWakeUpComposition.drainScheduled(env, config).then(() => undefined),
        ]),
      );
    } catch (error) {
      if (Schema.is(WorkerConfigurationError)(error)) logConfigurationError(error);
      throw error;
    }
  },
} satisfies ExportedHandler<CloudflareEnv>;

/** Default Cloudflare Worker entry point. */
export default worker;

const fetchApp = async (
  request: Request,
  app: Awaited<ReturnType<typeof App.makeCloudflareApp>>,
): Promise<Response> => {
  try {
    return await app.handler(request);
  } finally {
    await app.dispose();
  }
};

const logConfigurationError = (error: WorkerConfigurationError): void => {
  // oxlint-disable-next-line eslint/no-console, effecttsgo/global-console -- boundary: Cloudflare must record safe deployment failures.
  console.error(JSON.stringify({ message: error.message }));
};

const environmentErrorResponse = (): Response =>
  Response.json({ error: "The Worker runtime configuration is invalid" }, { status: 500 });
