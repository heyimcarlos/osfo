import { Redacted, Schema } from "effect";
import { getAgentByName } from "agents";

import * as App from "./app";
import { OSFO_DIRECTORY_NAME } from "./agents/osfo/directory";
import { loadConfig, WorkerConfigurationError, type CloudflareEnv } from "./config";
import * as DocumentCostReconciliation from "./document-cost-reconciliation";
import { makeWhatsAppAdapter } from "./integrations/whatsapp";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Cloudflare RPC tags and adapter boundaries require these forms. */

export { OsfoAgent } from "./agents/osfo/agent";
export { OsfoDirectory } from "./agents/osfo/directory";
export { ThinkMessengerStateAgent } from "@cloudflare/think/messengers";
export { RegistrationDialogue } from "./agents/registration/registration";
export { ExecutionUnitWorkflow } from "./workflows/runtime";
export { Sandbox } from "@cloudflare/sandbox";

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
  scheduled(_controller: ScheduledController, env: CloudflareEnv, context: ExecutionContext): void {
    try {
      const config = loadConfig(env);
      context.waitUntil(
        Promise.all([
          App.expireRegistrationInvitations(env, config),
          DocumentCostReconciliation.run(env),
        ]).then(() => undefined),
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
