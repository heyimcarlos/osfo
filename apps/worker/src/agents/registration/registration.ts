import { DurableObject } from "cloudflare:workers";
import { Option } from "effect";

import { decodeOsfoStage } from "../../env";
import {
  invalidOsfoEnvironment,
  makeRegistrationDialogueRuntime,
  probeExecutionUnit,
  type RuntimeProbeResult,
} from "../../layers";

/** Invitation-scoped Durable Object that hosts the restricted Registration Agent. */
export class RegistrationDialogue extends DurableObject<Env> {
  readonly #runtime = Option.map(decodeOsfoStage(this.env.OSFO_STAGE), (stage) =>
    makeRegistrationDialogueRuntime(this.ctx.id.name ?? this.ctx.id.toString(), stage),
  );

  /** Return the restricted runtime identity for local smoke verification. */
  probeRuntime(): Promise<RuntimeProbeResult> {
    return Option.match(this.#runtime, {
      onNone: () => Promise.resolve(invalidOsfoEnvironment),
      onSome: (runtime) => runtime.runPromise(probeExecutionUnit),
    });
  }
}
