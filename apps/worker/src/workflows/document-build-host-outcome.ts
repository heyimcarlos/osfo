import { Effect } from "effect";

import { DocumentBuild } from "../services/document-build";

/** Keep Cloudflare step retries active for storage and compute reconciliation ambiguity. */
export const requireRetryForRecoverableResult = <A extends object>(result: A): A => {
  if ("failure" in result && (result.failure === "recovery" || result.failure === "unavailable")) {
    throw new Error(
      result.failure === "recovery"
        ? "Document Build reconciliation is pending"
        : "Document Build execution host is temporarily unavailable",
    );
  }
  return result;
};

/** Bind an admitted payload to exactly one parent-derived Cloudflare instance. */
export const matchesInstanceIdentity = (
  kind: "main" | "timer",
  instanceId: string,
  payload: DocumentBuild.WorkflowPayload,
) =>
  DocumentBuild.cloudflareInstanceIdsFor(payload.workflowId).pipe(
    Effect.map((identities) => instanceId === identities[kind]),
  );
