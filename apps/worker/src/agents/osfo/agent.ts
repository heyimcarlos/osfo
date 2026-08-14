import { DurableObject } from "cloudflare:workers";
import { Option } from "effect";

import { decodeOsfoStage } from "../../env";
import {
  invalidOsfoEnvironment,
  makeOsfoAgentRuntime,
  probeExecutionUnit,
  type RuntimeProbeResult,
} from "../../layers";

/** User-scoped Durable Object host for the future Think integration. */
export class OsfoAgent extends DurableObject<Env> {
  readonly #runtime = Option.map(decodeOsfoStage(this.env.OSFO_STAGE), (stage) =>
    makeOsfoAgentRuntime(this.ctx.id.name ?? this.ctx.id.toString(), stage),
  );

  /** Return the technical runtime identity for local smoke verification. */
  probeRuntime(): Promise<RuntimeProbeResult> {
    return Option.match(this.#runtime, {
      onNone: () => Promise.resolve(invalidOsfoEnvironment),
      onSome: (runtime) => runtime.runPromise(probeExecutionUnit),
    });
  }
}
