import { Worker } from "alchemy/Cloudflare";

import { Artifacts } from "./Artifacts";
import { QualificationOwnerWorkflow } from "./QualificationOwnerWorkflow";

/** Private, stage-scoped owner for bounded qualification execution artifacts. */
export const QualificationOwner = Worker("QualificationOwner", {
  compatibility: {
    date: "2026-08-12",
    flags: ["nodejs_compat"],
  },
  env: {
    ARTIFACTS: Artifacts,
    QUALIFICATION_OWNER_WORKFLOW: QualificationOwnerWorkflow,
  },
  main: "./apps/worker/src/qualification-owner-worker.ts",
  observability: {
    enabled: true,
    logs: { enabled: true, headSamplingRate: 1, invocationLogs: true },
    traces: { enabled: true, headSamplingRate: 1 },
  },
});
