import type { WorkflowStepConfig } from "cloudflare:workers";

import { requireRetryForRecoverableResult } from "./document-build-host-outcome";

/* oxlint-disable effecttsgo/async-function -- This helper executes inside Cloudflare's Promise-only WorkflowStep callback. */

/** Throw inside the durable step callback so recoverable outcomes are never cached as success. */
export const runRecoverableMainOperation = async <A extends object>(operation: () => Promise<A>) =>
  requireRetryForRecoverableResult(await operation());

/** Recoverable product steps keep retry ownership beyond the 60-minute operation deadline. */
export const recoverableDocumentBuildStepConfig = {
  retries: { backoff: "constant", delay: "1 minute", limit: 70 },
  timeout: "2 minutes",
} satisfies WorkflowStepConfig;
