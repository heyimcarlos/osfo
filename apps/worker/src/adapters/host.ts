import type { Effect, ManagedRuntime } from "effect";

/** Lifecycle owned by the Cloudflare callback that enters Effect. */
export type HostRuntimeLifetime = "invocation" | "activation";

/** Run a fully handled Effect from a Cloudflare Promise callback. */
// oxlint-disable-next-line effecttsgo/async-function -- Cloudflare host callbacks require Promise results.
export const runHostEffect = async <Value, Requirements>(
  runtime: ManagedRuntime.ManagedRuntime<Requirements, never>,
  effect: Effect.Effect<Value, never, Requirements>,
  lifetime: HostRuntimeLifetime,
): Promise<Value> => {
  try {
    return await runtime.runPromise(effect);
  } finally {
    if (lifetime === "invocation") {
      await runtime.dispose();
    }
  }
};
