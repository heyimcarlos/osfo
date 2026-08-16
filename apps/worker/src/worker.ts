import { Result, Schema } from "effect";
import { getAgentByName } from "agents";

import * as App from "./app";
import { decodeRuntimeConfig } from "./env";
import { RuntimeProbeResult } from "./layers";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Cloudflare RPC tags and adapter boundaries require these forms. */

const AgentRpcTag = Schema.Struct({ _tag: Schema.String });
const RegistrationRpcResult = Schema.Union([
  Schema.TaggedStruct("RegistrationTurnCompleted", { response: Schema.String }),
  Schema.TaggedStruct("RegistrationTurnUnavailable", { message: Schema.String }),
]);

export { OsfoAgent } from "./agents/osfo/agent";
export { RegistrationDialogue } from "./agents/registration/registration";
export { ExecutionUnitWorkflow } from "./workflows/runtime";

/** Osfo Cloudflare Worker host. */
const worker = {
  fetch(request: Request, env: Env): Promise<Response> {
    const config = decodeRuntimeConfig(env);

    return Result.match(config, {
      onFailure: () => Promise.resolve(App.environmentErrorResponse()),
      onSuccess: (parsedConfig) => fetchApp(request, App.make(adaptBindings(env), parsedConfig)),
    });
  },
  scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): void {
    const config = decodeRuntimeConfig(env);
    Result.match(config, {
      onFailure: () => undefined,
      onSuccess: (parsedConfig) =>
        context.waitUntil(App.expireRegistrationInvitations(adaptBindings(env), parsedConfig)),
    });
  },
} satisfies ExportedHandler<Env>;

/** Default Cloudflare Worker entry point. */
export default worker;

const adaptBindings = (env: Env): App.Bindings => ({
  DB: env.DB,
  OSFO_AGENT: {
    getByName: (identity) => {
      const agent = env.OSFO_AGENT.getByName(identity);
      return {
        commitWelcome: async (input) =>
          Schema.decodePromise(AgentRpcTag)(await agent.commitWelcome(input)),
        initialize: async (input) =>
          Schema.decodePromise(AgentRpcTag)(await agent.initialize(input)),
        probeRuntime: async () =>
          Schema.decodePromise(RuntimeProbeResult)(await agent.probeRuntime()),
      };
    },
  },
  REGISTRATION_DIALOGUE: {
    getByName: (identity) => {
      const dialogue = () => getAgentByName(env.REGISTRATION_DIALOGUE, identity);
      return {
        begin: async (input) => {
          const agent = await dialogue();
          return Schema.decodePromise(RegistrationRpcResult)(await agent.begin(input));
        },
        deleteDialogue: async () => {
          const agent = await dialogue();
          await agent.deleteDialogue();
        },
        probeRuntime: async () => {
          const agent = await dialogue();
          return Schema.decodePromise(RuntimeProbeResult)(await agent.probeRuntime());
        },
      };
    },
  },
});

const fetchApp = async (request: Request, app: ReturnType<typeof App.make>): Promise<Response> => {
  try {
    return await app.handler(request);
  } finally {
    await app.dispose();
  }
};
