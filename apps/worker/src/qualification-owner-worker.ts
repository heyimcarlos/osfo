import { Option, Schema } from "effect";

import { qualificationChecksum } from "./qualification/qualification-checksum";
import type { QualificationOwnerWorkflowPayload } from "./workflow-contracts";

export { QualificationOwnerWorkflow } from "./workflows/qualification-owner";

const OwnerInvocation = Schema.Struct({
  executionId: Schema.String,
  manifestChecksum: Schema.String,
  planChecksum: Schema.String,
  requestArtifactChecksum: Schema.String,
  requestArtifactId: Schema.String,
});
const decodeOwnerInvocation = Schema.decodeUnknownPromise(Schema.fromJsonString(OwnerInvocation));
const RetainedOwnerRequest = Schema.Struct({
  artifactChecksum: Schema.String,
  authoritySources: Schema.Array(Schema.String),
  executionId: Schema.String,
  manifest: Schema.Unknown,
  manifestChecksum: Schema.String,
  plan: Schema.Unknown,
  planChecksum: Schema.String,
  protocolVersion: Schema.Literal("qualification-owner-v1"),
  shardRecordLimit: Schema.Literal(256),
});
const decodeRetainedOwnerRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(RetainedOwnerRequest),
);
const OwnerWorkflowResponse = Schema.Struct({
  body: Schema.Unknown,
  status: Schema.Int,
});
const decodeOwnerWorkflowResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(OwnerWorkflowResponse),
);

interface QualificationOwnerEnv {
  readonly ARTIFACTS: R2Bucket;
  readonly QUALIFICATION_OWNER_WORKFLOW: Workflow<QualificationOwnerWorkflowPayload>;
}

const validateRetainedRequest = (encoded: string, expectedChecksum: string): boolean => {
  const decoded = decodeRetainedOwnerRequest(encoded);
  if (Option.isNone(decoded)) return false;
  const { artifactChecksum, ...content } = decoded.value;
  return (
    artifactChecksum === expectedChecksum && artifactChecksum === qualificationChecksum(content)
  );
};

// oxlint-disable-next-line effecttsgo/async-function -- Cloudflare R2 is a Promise-native boundary.
const completedResponse = async (
  env: QualificationOwnerEnv,
  executionId: string,
): Promise<Response | null> => {
  const artifactId = `qualification/executions/${encodeURIComponent(executionId)}/owner-response.json`;
  const artifact = await env.ARTIFACTS.get(artifactId);
  if (artifact === null) return null;
  const decoded = decodeOwnerWorkflowResponse(await artifact.text());
  if (Option.isNone(decoded) || decoded.value.status < 200 || decoded.value.status > 599) {
    return Response.json({ error: "qualificationOwnerResponseConflict" }, { status: 409 });
  }
  return Response.json(decoded.value.body, { status: decoded.value.status });
};

/** Private qualification-owner service. It resumes immutable executions and fails closed. */
export default {
  // oxlint-disable-next-line effecttsgo/async-function -- Cloudflare's fetch boundary is Promise-native.
  async fetch(request: Request, env: QualificationOwnerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/executions") {
      return new Response(null, { status: 404 });
    }
    let invocation: typeof OwnerInvocation.Type;
    try {
      invocation = await decodeOwnerInvocation(await request.text());
    } catch {
      return Response.json({ error: "invalidQualificationOwnerInvocation" }, { status: 400 });
    }
    const requestArtifact = await env.ARTIFACTS.get(invocation.requestArtifactId);
    if (requestArtifact === null) {
      return Response.json({ error: "qualificationRequestArtifactMissing" }, { status: 424 });
    }
    const encodedRequest = await requestArtifact.text();
    if (!validateRetainedRequest(encodedRequest, invocation.requestArtifactChecksum)) {
      return Response.json({ error: "qualificationRequestArtifactConflict" }, { status: 409 });
    }
    const completed = await completedResponse(env, invocation.executionId);
    if (completed !== null) return completed;
    let instance: WorkflowInstance;
    try {
      instance = await env.QUALIFICATION_OWNER_WORKFLOW.create({
        id: invocation.executionId,
        params: invocation,
      });
    } catch {
      instance = await env.QUALIFICATION_OWNER_WORKFLOW.get(invocation.executionId);
    }
    const status = await instance.status();
    if (status.status === "errored" || status.status === "terminated") {
      return Response.json({ error: "qualificationOwnerWorkflowFailed" }, { status: 500 });
    }
    if (status.status === "complete") {
      const settled = await completedResponse(env, invocation.executionId);
      if (settled !== null) return settled;
      return Response.json({ error: "qualificationOwnerResponseMissing" }, { status: 500 });
    }
    return Response.json(
      { executionId: invocation.executionId, status: status.status },
      { headers: { "retry-after": "5" }, status: 202 },
    );
  },
} satisfies ExportedHandler<QualificationOwnerEnv>;
