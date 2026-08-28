import { requireRetryForRecoverableResult } from "./document-build-host-outcome";

/* oxlint-disable effecttsgo/async-function -- This helper executes inside Cloudflare's Promise-only WorkflowStep callback. */

/** Throw inside the durable step callback so recoverable outcomes are never cached as success. */
export const runRecoverableMainOperation = async <A extends object>(operation: () => Promise<A>) =>
  requireRetryForRecoverableResult(await operation());
