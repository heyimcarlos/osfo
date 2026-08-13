import { Option } from "effect";

import { runHostEffect } from "./adapters/host";
import { decodeOsfoStage } from "./env";
import { invalidOsfoEnvironment, makeWorkerRuntime, probeExecutionUnit } from "./layers";
import { routeRequest, runtimeProbeResponse } from "./router";

export { OsfoAgent } from "./agent/osfo-agent";
export { RegistrationDialogue } from "./registration-dialogue/registration-dialogue";
export { ExecutionUnitWorkflow } from "./workflows/runtime";

/** Osfo Cloudflare Worker host. */
const worker = {
  fetch(request: Request, env: Env): Promise<Response> {
    const stage = decodeOsfoStage(env.OSFO_STAGE);

    return Option.match(stage, {
      onNone: () => Promise.resolve(runtimeProbeResponse(invalidOsfoEnvironment)),
      onSome: (parsedStage) => {
        const runtime = makeWorkerRuntime(parsedStage);
        const response = routeRequest(request, env, probeExecutionUnit);

        return runHostEffect(runtime, response, "invocation");
      },
    });
  },
} satisfies ExportedHandler<Env>;

/** Default Cloudflare Worker entry point. */
export default worker;
