import { Result } from "effect";

import * as App from "./app";
import { decodeRuntimeConfig } from "./env";

export { OsfoAgent } from "./agents/osfo/agent";
export { RegistrationDialogue } from "./agents/registration/registration";
export { ExecutionUnitWorkflow } from "./workflows/runtime";

/** Osfo Cloudflare Worker host. */
const worker = {
  fetch(request: Request, env: Env): Promise<Response> {
    const config = decodeRuntimeConfig(env);

    return Result.match(config, {
      onFailure: () => Promise.resolve(App.environmentErrorResponse()),
      onSuccess: (parsedConfig) => fetchApp(request, App.make(env, parsedConfig)),
    });
  },
} satisfies ExportedHandler<Env>;

/** Default Cloudflare Worker entry point. */
export default worker;

// oxlint-disable-next-line effecttsgo/async-function -- The Cloudflare fetch boundary owns handler cleanup.
const fetchApp = async (request: Request, app: ReturnType<typeof App.make>): Promise<Response> => {
  try {
    return await app.handler(request);
  } finally {
    await app.dispose();
  }
};
