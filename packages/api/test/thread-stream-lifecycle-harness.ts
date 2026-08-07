import { ThreadStreamLifecycle, makeThreadStreamLifecycleLayer } from "../src/index.js";
import { ManagedRuntime } from "effect";

export const makeTestThreadStreamLifecycle = (maxConnections: number) => {
  const runtime = ManagedRuntime.make(
    makeThreadStreamLifecycleLayer({
      maxBufferedAgeMs: 30_000,
      maxBufferedBytes: 1_048_576,
      maxBufferedEvents: 100,
      maxConnectionLifetimeMs: 60_000,
      maxConnections,
    }),
  );
  return {
    lifecycle: runtime.runSync(ThreadStreamLifecycle),
    dispose: () => runtime.dispose(),
  };
};
