import type { Effect, ManagedRuntime } from "effect";

/** Run an Effect and dispose its invocation-scoped runtime. */
// oxlint-disable-next-line effecttsgo/async-function -- Cloudflare host callbacks require Promise results.
export const runInvocationEffect = async <Value, Failure, Requirements>(
  runtime: ManagedRuntime.ManagedRuntime<Requirements, never>,
  effect: Effect.Effect<Value, Failure, Requirements>,
): Promise<Value> => {
  try {
    return await runtime.runPromise(effect);
  } finally {
    await runtime.dispose();
  }
};
