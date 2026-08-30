/* oxlint-disable effecttsgo/global-date -- The authorized HTTP host boundary freezes and validates wall-clock cohort windows. */
import { getAgentByName } from "agents";
import { createDb } from "@osfo/db";
import postgres from "postgres";
import { Effect, Option, Predicate, type Redacted, Schema } from "effect";

import { OSFO_DIRECTORY_NAME, type OsfoDirectory } from "./agents/osfo/directory";
import { DocumentBuildFileResolution } from "./agents/osfo/document-build-file-resolution";
import { WebFileUpload } from "./agents/osfo/web-file-upload";
import { AgentId, UserId } from "./domain";
import { ActionId } from "./domain/action-execution";
import { AuthSessionId } from "./domain/auth-session";
import { makeQualificationCohortAuthority } from "./integrations/postgres/qualification-cohort";
import { qualificationEnrollmentDigest } from "./qualification/qualification-enrollment";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "./qualification/qualification-checksum";
import { qualificationWorkflowSubrequestHardLimit } from "./qualification/qualification-evaluation-limits";
import {
  createQualificationExecutionPlan,
  type QualificationExecutionPlan,
} from "./qualification/execution";
import {
  createBoundedBetaManifest,
  createScaleQualifiedPublicManifest,
  type ProductionQualificationManifest,
} from "./qualification/qualification-manifest";
import {
  decodeQualificationCohortManifest,
  qualificationDocumentBuildFixture,
  qualificationDocumentBuildFixtureBytes,
  qualificationDocumentBuildFixtureMatches,
  qualificationCohortArtifactId,
  qualificationParticipantGrantArtifactId,
  type QualificationCohortManifest,
} from "./qualification/qualification-cohort";

/* oxlint-disable effecttsgo/async-function -- Cloudflare, R2, and PostgreSQL are Promise-native owner boundaries. */
/* oxlint-disable eslint/no-underscore-dangle -- Closed RPC outcomes use Effect-style _tag discriminators. */

const Participant = Schema.Struct({
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  plan: Schema.Literals(["adventurer", "free"]),
  verifiedPhoneNumber: Schema.String.check(Schema.isMinLength(1)),
});
const Begin = Schema.Struct({
  acceptanceLevel: Schema.Literals(["BoundedBeta", "ScaleQualifiedPublic"]),
  action: Schema.Literal("begin"),
  executionId: Schema.String.check(Schema.isMinLength(1)),
  startsAtEpochMs: Schema.Int,
});
const ProvisionPage = Schema.Struct({
  action: Schema.Literal("provisionPage"),
  executionId: Schema.String.check(Schema.isMinLength(1)),
  pageIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  participants: Schema.Array(Participant).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
});
const FinalizePage = Schema.Struct({
  action: Schema.Literal("finalizePage"),
  executionId: Schema.String.check(Schema.isMinLength(1)),
  pageIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  plan: Schema.Literals(["adventurer", "free"]),
});
const Activate = Schema.Struct({
  action: Schema.Literal("activate"),
  executionId: Schema.String.check(Schema.isMinLength(1)),
});
const Invocation = Schema.Union([Begin, ProvisionPage, FinalizePage, Activate]);
const decodeInvocation = Schema.decodeUnknownOption(Schema.fromJsonString(Invocation));

interface QualificationCohortProvisionerBucket {
  readonly get: (key: string) => Promise<{ readonly text: () => Promise<string> } | null>;
  readonly put: (
    key: string,
    value: string,
    options: {
      readonly customMetadata: Record<string, string>;
      readonly httpMetadata: { readonly contentType: string };
      readonly onlyIf: { readonly etagDoesNotMatch: "*" };
    },
  ) => Promise<object | null>;
}

export interface QualificationCohortProvisionerEnv {
  readonly ARTIFACTS: QualificationCohortProvisionerBucket;
  readonly DB: Pick<Hyperdrive, "connectionString">;
  readonly OSFO_DIRECTORY?: DurableObjectNamespace<OsfoDirectory>;
  readonly QUALIFICATION_EMAIL_RECIPIENT?: string;
}

interface FrozenQualification {
  readonly manifest: ProductionQualificationManifest;
  readonly plan: QualificationExecutionPlan;
}

type QualificationDocumentBuildFixturePort = Pick<
  OsfoDirectory,
  "inspectDocumentBuildSourceSnapshot" | "uploadUserTextFile"
>;

export const prepareQualificationDocumentBuildFixture = async (
  port: QualificationDocumentBuildFixturePort,
  input: {
    readonly agentId: AgentId;
    readonly authSessionId: string;
    readonly executionId: string;
    readonly index: number;
    readonly plan: "adventurer" | "free";
    readonly policy: NonNullable<QualificationCohortManifest["documentBuildFixturePolicy"]>;
    readonly userId: UserId;
  },
): Promise<
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Missing" }
  | {
      readonly _tag: "Ready";
      readonly fixture: ReturnType<typeof qualificationDocumentBuildFixture>;
    }
> => {
  const fixture = qualificationDocumentBuildFixture(
    input.executionId,
    input.plan,
    input.index,
    input.policy,
  );
  const upload = await port.uploadUserTextFile(
    WebFileUpload.Request.make({
      actionId: ActionId.make(`qualification-file-fixture:${fixture.uploadId}`),
      authority: {
        _tag: "AuthSession",
        authSessionId: AuthSessionId.make(input.authSessionId),
        userId: input.userId,
      },
      bytes: Uint8Array.from(qualificationDocumentBuildFixtureBytes),
      fileId: fixture.fileId,
      fileName: fixture.fileName,
      uploadId: fixture.uploadId,
    }),
  );
  const snapshot = await port.inspectDocumentBuildSourceSnapshot(
    DocumentBuildFileResolution.VerificationRequest.make({
      agentId: input.agentId,
      fileId: fixture.fileId,
      userId: input.userId,
    }),
  );
  if (snapshot._tag === "Found") {
    return qualificationDocumentBuildFixtureMatches(fixture, snapshot, input.userId)
      ? { _tag: "Ready", fixture }
      : { _tag: "Conflict" };
  }
  return upload._tag === "Rejected" && upload.reason === "conflict"
    ? { _tag: "Conflict" }
    : { _tag: "Missing" };
};

const frozenQualification = (
  invocation: typeof Begin.Type,
  sourceVersion: string,
): FrozenQualification => {
  const versions = {
    dependencyVersions: {
      "@cloudflare/think": "0.15.1",
      agents: "0.20.1",
      effect: "4.0.0-rc.111",
    },
    hardLimits: [
      { maximum: 128, name: "workerMemory", unit: "MiB" },
      { maximum: 1_000, name: "workerSubrequests", unit: "requests" },
      qualificationWorkflowSubrequestHardLimit,
    ],
    sourceVersion,
    topologyVersion: "cloudflare-v1",
    workloadSeed: 17,
  } as const;
  const manifest =
    invocation.acceptanceLevel === "BoundedBeta"
      ? createBoundedBetaManifest(versions)
      : createScaleQualifiedPublicManifest(versions);
  return {
    manifest,
    plan: createQualificationExecutionPlan(
      manifest,
      invocation.startsAtEpochMs,
      invocation.executionId,
    ),
  };
};

const sha256Hex = async (encoded: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const retainExactQualificationArtifact = async (
  bucket: QualificationCohortProvisionerBucket,
  key: string,
  encoded: string,
  metadata: Record<string, string>,
): Promise<boolean> => {
  await bucket.put(key, encoded, {
    customMetadata: { ...metadata, "osfo-body-sha256": await sha256Hex(encoded) },
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  const existing = await bucket.get(key);
  return existing !== null && (await existing.text()) === encoded;
};

const exactParticipantPage = (
  participants: ReadonlyArray<typeof Participant.Type>,
  cohort: QualificationCohortManifest,
  pageIndex: number,
): boolean => {
  const positions = new Set(participants.map(({ index, plan }) => `${plan}:${index}`));
  const phones = new Set(participants.map(({ verifiedPhoneNumber }) => verifiedPhoneNumber));
  const totalParticipants = cohort.participantCounts.free + cohort.participantCounts.adventurer;
  const expectedLength = Math.min(50, totalParticipants - pageIndex * 50);
  return (
    expectedLength > 0 &&
    participants.length === expectedLength &&
    positions.size === participants.length &&
    phones.size === participants.length &&
    participants.every(({ index, plan }, offset) => {
      const globalPosition = pageIndex * 50 + offset;
      const freeCount = cohort.participantCounts.free;
      const expectedPlan = globalPosition < freeCount ? "free" : "adventurer";
      const expectedIndex = expectedPlan === "free" ? globalPosition : globalPosition - freeCount;
      return (
        plan === expectedPlan &&
        index === expectedIndex &&
        index < cohort.participantCounts[expectedPlan]
      );
    })
  );
};

const begin = async (
  invocation: typeof Begin.Type,
  sourceVersion: string,
  env: QualificationCohortProvisionerEnv,
): Promise<Response> => {
  const { manifest, plan } = frozenQualification(invocation, sourceVersion);
  if (invocation.startsAtEpochMs <= Date.now()) {
    return Response.json({ error: "qualificationCohortWindowInvalid" }, { status: 409 });
  }
  const planEndsAtEpochMs = plan.runs.at(-1)?.endsAtEpochMs ?? plan.startsAtEpochMs;
  const client = postgres(env.DB.connectionString, { fetch_types: false, max: 4, prepare: true });
  try {
    const authority = makeQualificationCohortAuthority(createDb(client));
    const cohortId = qualificationChecksum({
      executionId: plan.executionId,
      manifestChecksum: manifest.manifestChecksum,
      planChecksum: plan.planChecksum,
    });
    const begun = await Effect.runPromise(
      authority.beginOwned({
        cohortId,
        executionId: plan.executionId,
        expiresAt: new Date(planEndsAtEpochMs + 86_400_000),
        manifestChecksum: manifest.manifestChecksum,
        notBefore: new Date(plan.startsAtEpochMs),
        participantCounts: {
          adventurer: manifest.corpus.registeredUsers / 10,
          free: manifest.corpus.registeredUsers - manifest.corpus.registeredUsers / 10,
        },
        planChecksum: plan.planChecksum,
        sourceVersion: manifest.sourceVersion,
      }),
    );
    if (begun.status === "CONFLICT") {
      return Response.json({ error: "qualificationCohortConflict" }, { status: 409 });
    }
    const cohort = begun.manifest;
    const encodedCohort = canonicalQualificationJson(cohort);
    const cohortArtifactId = qualificationCohortArtifactId(plan.executionId);
    if (
      !(await retainExactQualificationArtifact(env.ARTIFACTS, cohortArtifactId, encodedCohort, {
        "osfo-cohort-id": cohort.cohortId,
        "osfo-execution-id": plan.executionId,
        "osfo-kind": "qualification-cohort-v1",
      }))
    ) {
      return Response.json({ error: "qualificationCohortArtifactConflict" }, { status: 409 });
    }
    return Response.json({
      cohortArtifactChecksum: cohort.artifactChecksum,
      cohortArtifactId,
      executionId: plan.executionId,
      manifestChecksum: manifest.manifestChecksum,
      participantCounts: cohort.participantCounts,
      planChecksum: plan.planChecksum,
      nextAction: "provisionPage",
      status: "PROVISIONING",
    });
  } finally {
    await client.end();
  }
};

const readCohort = async (
  executionId: string,
  env: QualificationCohortProvisionerEnv,
): Promise<QualificationCohortManifest | null> => {
  const cohortArtifactId = qualificationCohortArtifactId(executionId);
  const retainedCohort = await env.ARTIFACTS.get(cohortArtifactId);
  return retainedCohort === null
    ? null
    : decodeQualificationCohortManifest(await retainedCohort.text());
};

const provisionPage = async (
  invocation: typeof ProvisionPage.Type,
  secret: Redacted.Redacted,
  env: QualificationCohortProvisionerEnv,
): Promise<Response> => {
  const cohort = await readCohort(invocation.executionId, env);
  if (
    cohort === null ||
    cohort.executionId !== invocation.executionId ||
    !exactParticipantPage(invocation.participants, cohort, invocation.pageIndex)
  ) {
    return Response.json({ error: "qualificationParticipantPageConflict" }, { status: 409 });
  }
  if (Date.now() >= Date.parse(cohort.notBeforeUtc)) {
    return Response.json({ error: "qualificationCohortRegistrationWindowClosed" }, { status: 409 });
  }
  const participants = await Promise.all(
    invocation.participants.map(async (participant) => ({
      enrollmentDigest: await Effect.runPromise(
        qualificationEnrollmentDigest(secret, participant.verifiedPhoneNumber),
      ),
      index: participant.index,
      plan: participant.plan,
    })),
  );
  const client = postgres(env.DB.connectionString, { fetch_types: false, max: 2, prepare: true });
  try {
    const authority = makeQualificationCohortAuthority(createDb(client));
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each bounded page stops at the first durable authority conflict.
    for (const participant of participants) {
      const provisionId = qualificationChecksum({
        cohortId: cohort.cohortId,
        index: participant.index,
        plan: participant.plan,
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Provisioning is intentionally serialized within the bounded page.
      const provisioned = await Effect.runPromise(
        authority.provision({
          cohortId: cohort.cohortId,
          enrollmentDigest: participant.enrollmentDigest,
          executionId: cohort.executionId,
          expiresAt: new Date(cohort.expiresAtUtc),
          participantIndex: participant.index,
          plan: participant.plan,
          provisionId,
        }),
      );
      if (provisioned.status === "CONFLICT" || provisioned.status === "INELIGIBLE") {
        return Response.json(
          { error: "qualificationParticipantProvisionConflict" },
          { status: 409 },
        );
      }
    }
    const pageContent = {
      cohortChecksum: cohort.artifactChecksum,
      executionId: cohort.executionId,
      pageIndex: invocation.pageIndex,
      participants,
    };
    const pageReceipt = {
      ...pageContent,
      artifactChecksum: qualificationChecksum(pageContent),
    };
    const artifactId = `qualification/executions/${encodeURIComponent(cohort.executionId)}/cohort/provision-pages/${invocation.pageIndex.toString().padStart(8, "0")}.json`;
    return (await retainExactQualificationArtifact(
      env.ARTIFACTS,
      artifactId,
      canonicalQualificationJson(pageReceipt),
      {
        "osfo-cohort-id": cohort.cohortId,
        "osfo-execution-id": cohort.executionId,
        "osfo-kind": "qualification-cohort-provision-page-v1",
        "osfo-page-index": String(invocation.pageIndex),
      },
    ))
      ? Response.json({ artifactId, pageIndex: invocation.pageIndex, status: "RETAINED" })
      : Response.json({ error: "qualificationParticipantPageConflict" }, { status: 409 });
  } finally {
    await client.end();
  }
};

const finalizePage = async (
  invocation: typeof FinalizePage.Type,
  env: QualificationCohortProvisionerEnv,
): Promise<Response> => {
  const executionId = invocation.executionId;
  const cohortArtifactId = qualificationCohortArtifactId(executionId);
  const retainedCohort = await env.ARTIFACTS.get(cohortArtifactId);
  const cohort =
    retainedCohort === null ? null : decodeQualificationCohortManifest(await retainedCohort.text());
  if (cohort === null || cohort.executionId !== executionId) {
    return Response.json({ error: "qualificationCohortMissing" }, { status: 424 });
  }
  if (Date.now() >= Date.parse(cohort.notBeforeUtc)) {
    return Response.json({ error: "qualificationCohortRegistrationWindowClosed" }, { status: 409 });
  }
  const client = postgres(env.DB.connectionString, { fetch_types: false, max: 4, prepare: true });
  try {
    const authority = makeQualificationCohortAuthority(createDb(client));
    if (env.OSFO_DIRECTORY === undefined) {
      return Response.json({ error: "qualificationDirectoryUnavailable" }, { status: 424 });
    }
    const directory = await getAgentByName(env.OSFO_DIRECTORY, OSFO_DIRECTORY_NAME);
    const plan = invocation.plan;
    const firstIndex = invocation.pageIndex * 25;
    const expectedCount = Math.min(25, cohort.participantCounts[plan] - firstIndex);
    if (expectedCount <= 0) {
      return Response.json({ error: "qualificationFinalizePageConflict" }, { status: 409 });
    }
    const provisions = await Effect.runPromise(
      authority.listConsumedProvisionPage({
        afterIndex: firstIndex - 1,
        cohortId: cohort.cohortId,
        limit: expectedCount,
        plan,
      }),
    );
    if (provisions.length !== expectedCount) {
      return Response.json(
        {
          error: "qualificationParticipantRegistrationOrPlanMissing",
          pageIndex: invocation.pageIndex,
          plan,
        },
        { status: 424 },
      );
    }
    const retainedGrants = [];
    const scheduledEmailFields =
      env.QUALIFICATION_EMAIL_RECIPIENT === undefined ||
      env.QUALIFICATION_EMAIL_RECIPIENT.length < 3
        ? {}
        : {
            scheduledEmailFixture: {
              approval: "approveExactProtectedSend" as const,
              gmailResource: "primary" as const,
              recipient: env.QUALIFICATION_EMAIL_RECIPIENT,
              version: "qualification-scheduled-email-v1" as const,
            },
          };
    for (const [offset, provision] of provisions.entries()) {
      if (
        provision.agentId === null ||
        provision.consumedAt === null ||
        provision.userId === null ||
        provision.index !== firstIndex + offset
      ) {
        return Response.json({ error: "qualificationParticipantConflict" }, { status: 409 });
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Directory reads are bounded and ordered by canonical participant index.
      const agent = await directory.inspectAgent(AgentId.make(provision.agentId));
      if (agent === null) {
        return Response.json(
          { error: "qualificationParticipantAgentMissing", index: provision.index, plan },
          { status: 424 },
        );
      }
      const userId = UserId.make(provision.userId);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each participant must prove its own unexpired retained AuthSession in canonical order.
      const authSession = await Effect.runPromise(
        authority.readActiveAuthSession({ at: new Date(cohort.notBeforeUtc), userId }),
      );
      if (
        authSession === null ||
        authSession.userId !== userId ||
        cohort.documentBuildFixturePolicy === undefined
      ) {
        return Response.json(
          {
            error: "qualificationDocumentBuildFixtureAuthorityMissing",
            index: provision.index,
            plan,
          },
          { status: 424 },
        );
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Fixture creation is bounded to one normal product upload per canonical participant.
      const documentBuildFixture = await prepareQualificationDocumentBuildFixture(directory, {
        agentId: AgentId.make(provision.agentId),
        authSessionId: authSession.sessionId,
        executionId,
        index: provision.index,
        plan,
        policy: cohort.documentBuildFixturePolicy,
        userId,
      });
      if (documentBuildFixture._tag !== "Ready") {
        return Response.json(
          {
            error:
              documentBuildFixture._tag === "Conflict"
                ? "qualificationDocumentBuildFixtureConflict"
                : "qualificationDocumentBuildFixtureMissing",
            index: provision.index,
            plan,
          },
          { status: documentBuildFixture._tag === "Conflict" ? 409 : 424 },
        );
      }
      const content = {
        agentId: AgentId.make(provision.agentId),
        cohortChecksum: cohort.artifactChecksum,
        cohortId: cohort.cohortId,
        createdAtUtc: provision.consumedAt.toISOString(),
        documentBuildFixture: documentBuildFixture.fixture,
        executionId,
        expiresAtUtc: cohort.expiresAtUtc,
        index: provision.index,
        isolation: "disposableQualificationUser" as const,
        notBeforeUtc: cohort.notBeforeUtc,
        plan,
        provisionChecksum: provision.provisionChecksum,
        provisionId: provision.provisionId,
        routeId: agent.routeId,
        ...scheduledEmailFields,
        sessionId: agent.currentSessionId,
        status: "ACTIVE" as const,
        userId,
      };
      const grant = { ...content, artifactChecksum: qualificationChecksum(content) };
      // oxlint-disable-next-line eslint/no-await-in-loop -- Allocation must precede retention for each canonical grant.
      const allocation = await Effect.runPromise(
        authority.allocate({
          allocationId: qualificationChecksum({
            cohortId: cohort.cohortId,
            index: provision.index,
            plan,
          }),
          grant,
        }),
      );
      if (allocation === "CONFLICT" || allocation === "INELIGIBLE") {
        return Response.json({ error: "qualificationParticipantConflict" }, { status: 409 });
      }
      const artifactId = qualificationParticipantGrantArtifactId(cohort, plan, provision.index);
      if (
        // oxlint-disable-next-line eslint/no-await-in-loop -- Immutable grant retention is checked before advancing the page.
        !(await retainExactQualificationArtifact(
          env.ARTIFACTS,
          artifactId,
          canonicalQualificationJson(grant),
          {
            "osfo-agent-id": provision.agentId,
            "osfo-cohort-id": cohort.cohortId,
            "osfo-execution-id": executionId,
            "osfo-grant-checksum": grant.artifactChecksum,
            "osfo-index": String(provision.index),
            "osfo-kind": "qualification-participant-grant-v1",
            "osfo-plan": plan,
            "osfo-provision-checksum": provision.provisionChecksum,
            "osfo-provision-id": provision.provisionId,
            "osfo-session-id": agent.currentSessionId,
            "osfo-user-id": provision.userId,
          },
        ))
      ) {
        return Response.json({ error: "qualificationParticipantGrantConflict" }, { status: 409 });
      }
      retainedGrants.push({
        artifactChecksum: grant.artifactChecksum,
        artifactId,
        index: provision.index,
      });
    }
    const pageContent = {
      cohortChecksum: cohort.artifactChecksum,
      executionId,
      grants: retainedGrants,
      pageIndex: invocation.pageIndex,
      plan,
    };
    const pageReceipt = { ...pageContent, artifactChecksum: qualificationChecksum(pageContent) };
    const artifactId = `qualification/executions/${encodeURIComponent(executionId)}/cohort/finalize-pages/${plan}/${invocation.pageIndex.toString().padStart(8, "0")}.json`;
    const retainedPage = await retainExactQualificationArtifact(
      env.ARTIFACTS,
      artifactId,
      canonicalQualificationJson(pageReceipt),
      {
        "osfo-cohort-id": cohort.cohortId,
        "osfo-execution-id": executionId,
        "osfo-kind": "qualification-cohort-finalize-page-v1",
        "osfo-page-index": String(invocation.pageIndex),
        "osfo-plan": plan,
      },
    );
    if (!retainedPage) {
      return Response.json({ error: "qualificationFinalizePageConflict" }, { status: 409 });
    }
    const confirmed = await Effect.runPromise(
      authority.confirmFinalizationPage({
        cohortId: cohort.cohortId,
        executionId,
        firstParticipantIndex: firstIndex,
        pageIndex: invocation.pageIndex,
        participantCount: expectedCount,
        plan,
        receiptChecksum: pageReceipt.artifactChecksum,
        receiptId: artifactId,
      }),
    );
    return confirmed === "CONFIRMED" || confirmed === "EXISTING"
      ? Response.json({ artifactId, pageIndex: invocation.pageIndex, plan, status: "RETAINED" })
      : Response.json({ error: "qualificationFinalizePageConflict" }, { status: 409 });
  } finally {
    await client.end();
  }
};

const activate = async (
  executionId: string,
  env: QualificationCohortProvisionerEnv,
): Promise<Response> => {
  const cohort = await readCohort(executionId, env);
  if (cohort === null || Date.now() >= Date.parse(cohort.notBeforeUtc)) {
    return Response.json({ error: "qualificationCohortMissingOrExpired" }, { status: 424 });
  }
  const client = postgres(env.DB.connectionString, { fetch_types: false, max: 2, prepare: true });
  try {
    const authority = makeQualificationCohortAuthority(createDb(client));
    const provisions = await Effect.runPromise(authority.inspectProvisionInventory(cohort));
    if (!Predicate.isTagged(provisions, "Ready")) {
      return Response.json(
        { error: "qualificationParticipantRegistrationsMissing" },
        { status: 424 },
      );
    }
    const finalization = await Effect.runPromise(authority.inspectFinalizationInventory(cohort));
    if (!Predicate.isTagged(finalization, "Ready")) {
      return Response.json({ error: "qualificationParticipantGrantPagesMissing" }, { status: 424 });
    }
    const activated = await Effect.runPromise(authority.activate(cohort.cohortId));
    return Predicate.hasProperty(activated, "status") && activated.status === "ACTIVE"
      ? Response.json({ executionId, status: "READY" })
      : Response.json({ error: "qualificationCohortActivationConflict" }, { status: 409 });
  } finally {
    await client.end();
  }
};

/** Authorized cohort preparation/finalization boundary. Raw phone identities are never retained. */
export const runQualificationCohortProvisioner = async (
  request: Request,
  sourceVersion: string,
  secret: Redacted.Redacted,
  env: QualificationCohortProvisionerEnv,
): Promise<Response> => {
  const decoded = decodeInvocation(await request.text());
  if (Option.isNone(decoded)) {
    return Response.json({ error: "invalidQualificationCohortInvocation" }, { status: 400 });
  }
  switch (decoded.value.action) {
    case "activate":
      return activate(decoded.value.executionId, env);
    case "begin":
      return begin(decoded.value, sourceVersion, env);
    case "finalizePage":
      return finalizePage(decoded.value, env);
    case "provisionPage":
      return provisionPage(decoded.value, secret, env);
  }
  return Response.json({ error: "invalidQualificationCohortInvocation" }, { status: 400 });
};
