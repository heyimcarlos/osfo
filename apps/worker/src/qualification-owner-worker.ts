import { Option, Schema } from "effect";

import { qualificationChecksum } from "./qualification/qualification-checksum";
import type { QualificationOwnerWorkflowPayload } from "./workflow-contracts";

export { QualificationOwnerWorkflow } from "./workflows/qualification-owner";
export { QualificationOwnerPartitionWorkflow } from "./workflows/qualification-owner-partition";
export { QualificationEvaluationCorrectnessReducerWorkflow } from "./workflows/qualification-evaluation-correctness-reducer";
export { QualificationEvaluationReducerWorkflow } from "./workflows/qualification-evaluation-reducer";
export { QualificationEvaluationLeafWorkflow } from "./workflows/qualification-evaluation-leaf";
export { QualificationOwnerDimensionCoordinatorWorkflow } from "./workflows/qualification-owner-dimension-coordinator";

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
  cohortArtifactChecksum: Schema.String,
  cohortArtifactId: Schema.String,
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
const DistributedOwnerWorkflowResponse = Schema.Struct({
  body: Schema.Struct({
    completionArtifactId: Schema.String,
    completionChecksum: Schema.String,
    error: Schema.Literals([
      "qualificationAuthorityConflict",
      "qualificationAuthorityMaterialMissing",
    ]),
    executionId: Schema.String,
    failingFamilies: Schema.Array(Schema.String),
    manifestChecksum: Schema.String,
    missingFamilies: Schema.Array(Schema.String),
    phase: Schema.Literal("PRE_TEARDOWN"),
    planChecksum: Schema.String,
    reportArtifactId: Schema.String,
    reportChecksum: Schema.String,
    verdict: Schema.Literals(["FAIL", "MISSING"]),
    version: Schema.Literal("qualification-owner-response-v2"),
  }),
  status: Schema.Int,
});
const decodeOwnerWorkflowResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(OwnerWorkflowResponse),
);
const decodeDistributedOwnerWorkflowResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(DistributedOwnerWorkflowResponse),
);
const decodeOwnerResponseVersion = Schema.decodeUnknownOption(
  Schema.Struct({ version: Schema.String }),
);

interface QualificationOwnerInstance {
  readonly status: () => Promise<InstanceStatus>;
}

interface QualificationOwnerEnv {
  readonly ARTIFACTS: {
    readonly get: (key: string) => Promise<{
      readonly customMetadata?: Readonly<Record<string, string>>;
      readonly httpMetadata?: { readonly contentType?: string };
      readonly text: () => Promise<string>;
    } | null>;
  };
  readonly QUALIFICATION_OWNER_WORKFLOW: {
    readonly create: (options: {
      readonly id: string;
      readonly params: QualificationOwnerWorkflowPayload;
    }) => Promise<QualificationOwnerInstance>;
    readonly get: (id: string) => Promise<QualificationOwnerInstance>;
  };
}

const validatedRetainedRequest = (
  encoded: string,
  expectedChecksum: string,
): typeof RetainedOwnerRequest.Type | null => {
  const decoded = decodeRetainedOwnerRequest(encoded);
  if (Option.isNone(decoded)) return null;
  const { artifactChecksum, ...content } = decoded.value;
  return artifactChecksum === expectedChecksum &&
    artifactChecksum === qualificationChecksum(content)
    ? decoded.value
    : null;
};

const exactMetadata = (
  actual: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>>,
) =>
  actual !== undefined &&
  Object.keys(actual).length === Object.keys(expected).length &&
  Object.entries(expected).every(([key, value]) => actual[key] === value);

// oxlint-disable-next-line effecttsgo/async-function -- Cloudflare R2 is a Promise-native boundary.
const completedResponse = async (
  env: QualificationOwnerEnv,
  executionId: string,
): Promise<Response | null> => {
  const artifactId = `qualification/executions/${encodeURIComponent(executionId)}/owner-response.json`;
  const artifact = await env.ARTIFACTS.get(artifactId);
  if (artifact === null) return null;
  const encoded = await artifact.text();
  const distributed = decodeDistributedOwnerWorkflowResponse(encoded);
  if (Option.isSome(distributed)) {
    const response = distributed.value;
    const expectedStatus = response.body.verdict === "FAIL" ? 409 : 424;
    const expectedError =
      response.body.verdict === "FAIL"
        ? "qualificationAuthorityConflict"
        : "qualificationAuthorityMaterialMissing";
    if (
      response.body.executionId !== executionId ||
      response.body.error !== expectedError ||
      response.status !== expectedStatus ||
      artifact.httpMetadata?.contentType !== "application/json" ||
      !exactMetadata(artifact.customMetadata, {
        "osfo-execution-id": executionId,
        "osfo-kind": "qualification-owner-response-v2",
        "osfo-report-checksum": response.body.reportChecksum,
        "osfo-verdict": response.body.verdict,
      })
    ) {
      return Response.json({ error: "qualificationOwnerResponseConflict" }, { status: 409 });
    }
    return Response.json(response.body, { status: response.status });
  }
  const decoded = decodeOwnerWorkflowResponse(encoded);
  if (Option.isNone(decoded) || decoded.value.status < 200 || decoded.value.status > 599) {
    return Response.json({ error: "qualificationOwnerResponseConflict" }, { status: 409 });
  }
  const version = decodeOwnerResponseVersion(decoded.value.body);
  if (
    artifact.customMetadata?.["osfo-kind"] === "qualification-owner-response-v2" ||
    (Option.isSome(version) && version.value.version === "qualification-owner-response-v2")
  ) {
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
    const retainedRequest = validatedRetainedRequest(
      encodedRequest,
      invocation.requestArtifactChecksum,
    );
    const expectedRequestArtifactId = `qualification/executions/${encodeURIComponent(invocation.executionId)}/owner-request.json`;
    if (
      retainedRequest === null ||
      invocation.requestArtifactId !== expectedRequestArtifactId ||
      retainedRequest.executionId !== invocation.executionId ||
      retainedRequest.manifestChecksum !== invocation.manifestChecksum ||
      retainedRequest.planChecksum !== invocation.planChecksum
    ) {
      return Response.json({ error: "qualificationRequestArtifactConflict" }, { status: 409 });
    }
    const completed = await completedResponse(env, invocation.executionId);
    if (completed !== null) return completed;
    let instance: QualificationOwnerInstance;
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
