import { BrowserCrypto } from "@effect/platform-browser";
import { Effect, Layer, Schema, type ManagedRuntime } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import type { AuthDependencies } from "./auth";
import { loadConfig, type CloudflareConfig, type CloudflareEnv } from "./config";
import { Db } from "./db";
import { TwilioVerify } from "./integrations/twilio/verify";
import { makeWorkerRuntime, type ExecutionUnit } from "./layers";
import { Routes } from "./routes";
import { ChannelLinks } from "./services/channel-links";
import { OSFO_DIRECTORY_NAME } from "./agents/osfo/identity";
import { AccountDeletionComposition } from "./composition/account-deletion";
import { ComposioAccountDeletion } from "./integrations/composio/account-deletion";
import { SupermemoryMemoryProvider } from "./integrations/supermemory/memory-provider";
import { AccountDeletion } from "./services/account-deletion";

/* oxlint-disable effecttsgo/async-function -- Cloudflare RPC adapters expose Promise-based interfaces. */

/** Cloudflare bindings used by the Worker HTTP application. */
export interface Bindings {
  readonly ARTIFACTS?: R2Bucket;
  readonly FILES?: R2Bucket;
  readonly integrationAuthorityDeletion: AccountDeletionComposition.IntegrationAuthorityDeletionCapability;
  readonly DB: Pick<Hyperdrive, "connectionString">;
  readonly OSFO_DIRECTORY: Routes.Bindings["OSFO_DIRECTORY"];
  readonly RESEARCH_REPORT_TIMER_WORKFLOW?: CloudflareEnv["RESEARCH_REPORT_TIMER_WORKFLOW"];
  readonly RESEARCH_REPORT_WORKFLOW?: CloudflareEnv["RESEARCH_REPORT_WORKFLOW"];
  readonly routeOsfoAgentRequest: Routes.Bindings["routeOsfoAgentRequest"];
}

/** Optional concrete dependency choices for application composition. */
export interface MakeOptions {
  readonly authDependencies?: AuthDependencies;
}

const AgentRpcTag = Schema.Struct({ _tag: Schema.String });

/** Build one request-scoped Cloudflare application from the current bindings. */
export const makeCloudflareApp = async (env: CloudflareEnv) => {
  const config = loadConfig(env);
  const runtime = makeWorkerRuntime(config.stage);
  const webHandler = makeWebHandler(adaptBindings(env, config), config, runtime);

  return {
    dispose: () => webHandler.dispose().then(() => runtime.dispose()),
    handler: webHandler.handler,
  };
};

/** Build one request-scoped Effect HTTP application. */
export const make = (env: Bindings, config: CloudflareConfig, options?: MakeOptions) => {
  const runtime = makeWorkerRuntime(config.stage);
  const webHandler = makeWebHandler(env, config, runtime, options);

  return {
    dispose: () => webHandler.dispose().then(() => runtime.dispose()),
    handler: webHandler.handler,
  };
};

const makeWebHandler = (
  env: Bindings,
  config: CloudflareConfig,
  runtime: ManagedRuntime.ManagedRuntime<ExecutionUnit, never>,
  options?: MakeOptions,
) => {
  const authDependencies =
    options?.authDependencies ??
    Layer.merge(Db.layer({ db: env.DB }), TwilioVerify.layer(config.twilioVerify));
  const appLayer = Routes.layer({
    authDependencies,
    config,
    env,
    runtime,
  }).pipe(Layer.provide(BrowserCrypto.layer), Layer.provide(HttpServer.layerServices));
  return HttpRouter.toWebHandler(appLayer, {
    disableLogger: true,
    // Signed Channel Link Invite claims are intentionally larger than the router's 100-byte default.
    routerConfig: { maxParamLength: 512 },
  });
};

/** Delete expired Channel Link Invite data from the scheduled Worker event. */
export const expireChannelLinkInvites = (env: CloudflareEnv) => {
  const base = Layer.merge(Db.layer({ db: env.DB }), BrowserCrypto.layer);
  return Effect.runPromise(
    Effect.scoped(
      ChannelLinks.expirePending().pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Scheduled maintenance is an application entry point.
        Effect.provide(base),
      ),
    ),
  );
};

/** Retry every fenced account until provider, R2, Agent SQLite, and PostgreSQL erasure complete. */
export const reconcileAccountDeletions = (env: CloudflareEnv) => {
  const config = loadConfig(env);
  const base = Layer.merge(
    Db.layer({ db: env.DB }),
    SupermemoryMemoryProvider.layerFromConfig(config.supermemory),
  );
  const deletionLayer = AccountDeletionComposition.layer(adaptBindings(env, config)).pipe(
    Layer.provide(base),
  );
  return Effect.runPromise(
    Effect.scoped(
      AccountDeletion.Service.pipe(
        Effect.flatMap((deletion) => deletion.reconcilePending()),
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Scheduled maintenance is an application entry point.
        Effect.provide(deletionLayer),
      ),
    ),
  );
};

const adaptBindings = (env: CloudflareEnv, config: CloudflareConfig): Bindings => ({
  ARTIFACTS: env.ARTIFACTS,
  FILES: env.FILES,
  integrationAuthorityDeletion:
    config.composio === null
      ? AccountDeletionComposition.integrationAuthorityDeletionNotDelivered
      : {
          _tag: "Delivered",
          adapter: ComposioAccountDeletion.make(config.composio.apiKey),
        },
  DB: env.DB,
  OSFO_DIRECTORY: {
    getByName: () => {
      const directory = env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
      return {
        ensureAgent: async (agentId) => {
          const identity = await directory.ensureAgent(agentId);
          return { className: identity.className, name: identity.name };
        },
        initializeAgent: async (agentId, input) =>
          Schema.decodePromise(AgentRpcTag)(await directory.initializeAgent(agentId, input)),
        deleteAgent: (agentId) => directory.deleteAgent(agentId),
        inspectPersonalSkills: (agentId, actor) => directory.inspectPersonalSkills(agentId, actor),
        inspectIntegrationConnections: (agentId, actor) =>
          directory.inspectIntegrationConnections(agentId, actor),
        connectIntegrationFromSettings: (agentId, input) =>
          directory.connectIntegrationFromSettings(agentId, input),
        disconnectIntegrationFromSettings: (agentId, input) =>
          directory.disconnectIntegrationFromSettings(agentId, input),
        changePersonalSkill: (agentId, input) => directory.changePersonalSkill(agentId, input),
        presentPersonalSkillDeletion: (agentId, input) =>
          directory.presentPersonalSkillDeletion(agentId, input),
        deletePersonalSkillFromSettings: (agentId, input) =>
          directory.deletePersonalSkillFromSettings(agentId, input),
        quiesceAgentAccountDeletion: (agentId, userId) =>
          directory.quiesceAgentAccountDeletion(agentId, userId),
      };
    },
  },
  RESEARCH_REPORT_TIMER_WORKFLOW: env.RESEARCH_REPORT_TIMER_WORKFLOW,
  RESEARCH_REPORT_WORKFLOW: env.RESEARCH_REPORT_WORKFLOW,
  routeOsfoAgentRequest: async (request, agentId, childPath) => {
    const { camelCaseToKebabCase, routeSubAgentRequest } = await import("agents");
    const { OsfoAgent } = await import("./agents/osfo/agent");
    const directory = env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
    const segment = camelCaseToKebabCase(OsfoAgent.name);
    return routeSubAgentRequest(request, directory, {
      fromPath: `/sub/${segment}/${agentId}${childPath}`,
    });
  },
});

export * as App from "./app";
