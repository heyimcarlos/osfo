import type { ManagedRuntime } from "effect";

import * as Health from "./handlers/health";
import type { ExecutionUnit } from "./layers";

/** Implement every typed Osfo API group. */
export const layer = (runtime: ManagedRuntime.ManagedRuntime<ExecutionUnit, never>) =>
  Health.layer(runtime);
