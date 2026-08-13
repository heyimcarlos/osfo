import { DurableObject } from "cloudflare:workers";
import { Option } from "effect";

import { runHostEffect } from "../adapters/host";
import { decodeOsfoStage } from "../env";
import {
  invalidOsfoEnvironment,
  makeRegistrationDialogueRuntime,
  probeExecutionUnit,
  type RuntimeProbeResult,
} from "../layers";

/** Invitation-scoped Durable Object with no User or Agent authority. */
export class RegistrationDialogue extends DurableObject<Env> {
  readonly #runtime = Option.map(decodeOsfoStage(this.env.OSFO_STAGE), (stage) =>
    makeRegistrationDialogueRuntime(this.ctx.id.name ?? this.ctx.id.toString(), stage),
  );

  /** Return the restricted runtime identity for local smoke verification. */
  probeRuntime(): Promise<RuntimeProbeResult> {
    return Option.match(this.#runtime, {
      onNone: () => Promise.resolve(invalidOsfoEnvironment),
      onSome: (runtime) => runHostEffect(runtime, probeExecutionUnit, "activation"),
    });
  }
}
