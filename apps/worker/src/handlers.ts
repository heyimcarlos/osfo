import { Layer, type ManagedRuntime } from "effect";

import * as Billing from "./handlers/billing";
import * as Health from "./handlers/health";
import * as Onboarding from "./handlers/onboarding";
import * as Registration from "./handlers/registration";
import type { ExecutionUnit } from "./layers";
import type { RuntimeConfig } from "./env";

/** Implement every typed Osfo API group. */
export const layer = (
  runtime: ManagedRuntime.ManagedRuntime<ExecutionUnit, never>,
  config: RuntimeConfig,
) =>
  Layer.mergeAll(
    Billing.layer(config),
    Health.layer(runtime),
    Onboarding.layer,
    Registration.layer,
  );
