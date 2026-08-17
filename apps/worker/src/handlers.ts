import { Layer, type ManagedRuntime } from "effect";

import * as Health from "./handlers/health";
import * as Gmail from "./handlers/gmail";
import * as Onboarding from "./handlers/onboarding";
import * as Registration from "./handlers/registration";
import type { ExecutionUnit } from "./layers";

/** Implement every typed Osfo API group. */
export const layer = (runtime: ManagedRuntime.ManagedRuntime<ExecutionUnit, never>) =>
  Layer.mergeAll(Gmail.layer, Health.layer(runtime), Onboarding.layer, Registration.layer);
