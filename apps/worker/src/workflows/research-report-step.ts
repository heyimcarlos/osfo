import type { WorkflowStepConfig } from "cloudflare:workers";

import { documentExecutionLeaseMs } from "../integrations/cloudflare/document-compute";

const retryDelayMs = 2 * 60_000;

export const recoverableResearchReportStepConfig = {
  retries: {
    backoff: "constant",
    delay: retryDelayMs,
    // Reclaim missing output after lease expiry, then retry the same render identity.
    limit: Math.ceil(documentExecutionLeaseMs / retryDelayMs) + 1,
  },
} satisfies WorkflowStepConfig;
