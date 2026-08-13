import type { WorkerObservability } from "alchemy/Cloudflare";

/** Non-secret observability settings for the Osfo Worker. */
export const workerObservability = {
  enabled: true,
  logs: {
    enabled: true,
    headSamplingRate: 1,
    invocationLogs: true,
  },
  traces: {
    enabled: true,
    headSamplingRate: 1,
  },
} satisfies WorkerObservability;
