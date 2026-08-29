import { Schema } from "effect";

import { createQualificationExecutionPlan } from "../../qualification/execution";
import { canonicalQualificationJson } from "../../qualification/qualification-checksum";
import {
  createBoundedBetaManifest,
  createScaleQualifiedPublicManifest,
} from "../../qualification/qualification-manifest";
import type { QualificationExecutionListingBucket } from "./qualification-execution-artifacts";
import { runProductionQualification } from "./production-qualification";

const TriggerInvocation = Schema.Struct({
  acceptanceLevel: Schema.Literals(["BoundedBeta", "ScaleQualifiedPublic"]),
  executionId: Schema.String,
  startsAtEpochMs: Schema.Int,
  versions: Schema.Struct({
    dependencyVersions: Schema.Record(Schema.String, Schema.String),
    hardLimits: Schema.Array(
      Schema.Struct({ maximum: Schema.Finite, name: Schema.String, unit: Schema.String }),
    ),
    sourceVersion: Schema.String,
    topologyVersion: Schema.String,
    workloadSeed: Schema.Int,
  }),
});
const decodeTriggerInvocation = Schema.decodeUnknownPromise(
  Schema.fromJsonString(TriggerInvocation),
);

export interface QualificationTriggerBindings {
  readonly ARTIFACTS: QualificationExecutionListingBucket;
  readonly QUALIFICATION_OWNER:
    | {
        readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
      }
    | undefined;
  readonly QUALIFICATION_TRIGGER_TOKEN: string | undefined;
}

// oxlint-disable-next-line effecttsgo/async-function -- Web Crypto's digest boundary is Promise-native.
const sameSecret = async (left: string, right: string): Promise<boolean> => {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
};

/** Authorized operator trigger for one already-retained immutable qualification request. */
// oxlint-disable-next-line effecttsgo/async-function -- Cloudflare's request boundary is Promise-native.
export const runQualificationTrigger = async (
  request: Request,
  env: QualificationTriggerBindings,
): Promise<Response> => {
  const token = env.QUALIFICATION_TRIGGER_TOKEN;
  const owner = env.QUALIFICATION_OWNER;
  if (token === undefined || token.length === 0 || owner === undefined) {
    return Response.json({ error: "qualificationExecutionUnavailable" }, { status: 503 });
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (!(await sameSecret(authorization, `Bearer ${token}`))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let invocation: typeof TriggerInvocation.Type;
  try {
    invocation = await decodeTriggerInvocation(await request.text());
  } catch {
    return Response.json({ error: "invalidQualificationInvocation" }, { status: 400 });
  }
  const manifest =
    invocation.acceptanceLevel === "BoundedBeta"
      ? createBoundedBetaManifest(invocation.versions)
      : createScaleQualifiedPublicManifest(invocation.versions);
  const plan = createQualificationExecutionPlan(
    manifest,
    invocation.startsAtEpochMs,
    invocation.executionId,
  );
  const report = await runProductionQualification(
    { ARTIFACTS: env.ARTIFACTS, QUALIFICATION_OWNER: owner },
    manifest,
    plan,
  );
  return new Response(canonicalQualificationJson(report), {
    headers: { "content-type": "application/json" },
  });
};
