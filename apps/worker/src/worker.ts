import { Option } from "effect";

import * as App from "./app";
import { decodeOsfoStage } from "./env";
import { invalidOsfoEnvironment } from "./layers";

export { OsfoAgent } from "./agent/osfo-agent";
export { RegistrationDialogue } from "./registration-dialogue/registration-dialogue";
export { ExecutionUnitWorkflow } from "./workflows/runtime";

/** Osfo Cloudflare Worker host. */
const worker = {
  fetch(request: Request, env: Env): Promise<Response> {
    const stage = decodeOsfoStage(env.OSFO_STAGE);

    return Option.match(stage, {
      onNone: () => Promise.resolve(App.environmentErrorResponse(invalidOsfoEnvironment)),
      onSome: (parsedStage) => fetchApp(request, App.make(env, parsedStage)),
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
