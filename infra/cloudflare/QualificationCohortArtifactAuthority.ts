import { DurableObject } from "alchemy/Cloudflare";

/** Execution-scoped exclusive writer and lifecycle fence for qualification cohort artifacts. */
export const QualificationCohortArtifactAuthority = DurableObject(
  "QualificationCohortArtifactAuthority",
  { className: "QualificationCohortArtifactAuthority" },
);
