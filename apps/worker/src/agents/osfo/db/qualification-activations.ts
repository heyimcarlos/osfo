import { and, asc, eq } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";

import { SessionId, ThinkSubmissionId } from "../../../domain";
import { QualificationAdmissionReceipt } from "../../../qualification/qualification-attempt";
import { qualificationChecksum } from "../../../qualification/qualification-checksum";
import type { AgentDb } from "./client";
import {
  qualificationActivationReceipts,
  qualificationActivationState,
  qualificationAdmissions,
  qualificationAdmittedRequestActivations,
  qualificationRuntimeActivations,
} from "./schema";

/* oxlint-disable eslint/no-underscore-dangle -- Closed activation outcomes use the repository-standard _tag discriminator. */

export type QualificationActivationCause = "deployment" | "firstUse" | "warm";

export interface QualificationActivationRequestState {
  readonly lastActivationId: string | null;
  readonly lastDeploymentVersionId: string | null;
  readonly requestCount: number;
}

export interface QualificationActivationCauseInput {
  readonly currentActivationId: string;
  readonly currentDeploymentVersionId: string | null;
  readonly firstUseClaimed: boolean;
  readonly historyComplete: boolean;
  readonly state: QualificationActivationRequestState | null;
}

/** Classify only activation facts proved by durable Agent-local request history. */
export const qualificationActivationCause = ({
  currentActivationId,
  currentDeploymentVersionId,
  firstUseClaimed,
  historyComplete,
  state,
}: QualificationActivationCauseInput): QualificationActivationCause | null => {
  if (!historyComplete || state === null) return null;
  if (firstUseClaimed && state.requestCount === 0) return "firstUse";
  if (state.lastActivationId === currentActivationId) return "warm";
  if (
    currentDeploymentVersionId !== null &&
    state.lastDeploymentVersionId !== null &&
    state.lastDeploymentVersionId !== currentDeploymentVersionId
  ) {
    return "deployment";
  }
  return null;
};

const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

export const QualificationAdmittedRequestActivation = Schema.Struct({
  activationId: identity,
  cause: Schema.NullOr(Schema.Literals(["deployment", "firstUse", "warm"])),
  classification: Schema.NullOr(Schema.Literals(["cold", "warm"])),
  deploymentVersionId: Schema.NullOr(identity),
  observedAt: Schema.String,
  requestId: identity,
  requestSequence: Schema.Int.check(Schema.isGreaterThan(0)),
  sessionId: identity,
});

export type QualificationAdmittedRequestActivation =
  typeof QualificationAdmittedRequestActivation.Type;

export const QualificationActivationReceipt = Schema.Struct({
  activationId: identity,
  artifactChecksum: identity,
  attemptId: identity,
  cause: Schema.NullOr(Schema.Literals(["deployment", "firstUse", "warm"])),
  classification: Schema.NullOr(Schema.Literals(["cold", "warm"])),
  deploymentVersionId: Schema.NullOr(identity),
  executionId: identity,
  occurredAt: Schema.String,
  planChecksum: identity,
  productFactId: identity,
  region: Schema.Literals(["americas", "asiaPacific", "europe"]),
  requestId: identity,
  rootId: identity,
  runId: identity,
  sessionId: identity,
});

export type QualificationActivationReceipt = typeof QualificationActivationReceipt.Type;

export class QualificationActivationStoreUnavailable extends Data.TaggedError(
  "QualificationActivationStoreUnavailable",
)<{ readonly cause: unknown; readonly message: string }> {}

export class QualificationActivationConflict extends Data.TaggedError(
  "QualificationActivationConflict",
)<{ readonly identity: string; readonly message: string }> {}

const sqliteUtc = (value: string): string =>
  value.includes("T") ? value : `${value.replace(" ", "T")}Z`;

const admittedRequestFields = {
  activationId: qualificationAdmittedRequestActivations.activation_id,
  cause: qualificationAdmittedRequestActivations.cause,
  classification: qualificationAdmittedRequestActivations.classification,
  deploymentVersionId: qualificationAdmittedRequestActivations.deployment_version_id,
  observedAt: qualificationAdmittedRequestActivations.observed_at,
  requestId: qualificationAdmittedRequestActivations.request_id,
  requestSequence: qualificationAdmittedRequestActivations.request_sequence,
  sessionId: qualificationAdmittedRequestActivations.session_id,
};

const activationReceiptFields = {
  activationId: qualificationActivationReceipts.activation_id,
  artifactChecksum: qualificationActivationReceipts.artifact_checksum,
  attemptId: qualificationActivationReceipts.attempt_id,
  cause: qualificationActivationReceipts.cause,
  classification: qualificationActivationReceipts.classification,
  deploymentVersionId: qualificationActivationReceipts.deployment_version_id,
  executionId: qualificationActivationReceipts.execution_id,
  occurredAt: qualificationActivationReceipts.occurred_at,
  planChecksum: qualificationActivationReceipts.plan_checksum,
  productFactId: qualificationActivationReceipts.product_fact_id,
  region: qualificationActivationReceipts.region,
  requestId: qualificationActivationReceipts.request_id,
  rootId: qualificationActivationReceipts.root_id,
  runId: qualificationActivationReceipts.run_id,
  sessionId: qualificationActivationReceipts.session_id,
};

const admissionFields = {
  acceptanceReceiptId: qualificationAdmissions.acceptance_receipt_id,
  admissionDecision: qualificationAdmissions.admission_decision,
  agentId: qualificationAdmissions.agent_id,
  artifactChecksum: qualificationAdmissions.artifact_checksum,
  attemptId: qualificationAdmissions.attempt_id,
  executionId: qualificationAdmissions.execution_id,
  occurredAt: qualificationAdmissions.occurred_at,
  planChecksum: qualificationAdmissions.plan_checksum,
  productFactId: qualificationAdmissions.product_fact_id,
  rootId: qualificationAdmissions.root_id,
  runId: qualificationAdmissions.run_id,
  thinkSubmissionId: qualificationAdmissions.think_submission_id,
  userMessageId: qualificationAdmissions.user_message_id,
  userUpdateId: qualificationAdmissions.user_update_id,
};

interface AdmittedRequestRow {
  readonly activationId: string;
  readonly cause: QualificationActivationCause | null;
  readonly classification: "cold" | "warm" | null;
  readonly deploymentVersionId: string | null;
  readonly observedAt: string;
  readonly requestId: string;
  readonly requestSequence: number;
  readonly sessionId: string;
}

const decodeAdmittedRequest = (value: AdmittedRequestRow): QualificationAdmittedRequestActivation =>
  Schema.decodeSync(QualificationAdmittedRequestActivation)({
    ...value,
    observedAt: sqliteUtc(value.observedAt),
  });

const exactAdmittedRequest = (
  retained: QualificationAdmittedRequestActivation,
  input: {
    readonly activationId: string;
    readonly deploymentVersionId: string | null;
    readonly requestId: string;
    readonly sessionId: string;
  },
): boolean =>
  retained.activationId === input.activationId &&
  retained.deploymentVersionId === input.deploymentVersionId &&
  retained.requestId === input.requestId &&
  retained.sessionId === input.sessionId;

export interface QualificationRuntimeActivationClaim {
  readonly activationId: string;
  readonly deploymentVersionId: string | null;
  readonly firstUseClaimed: boolean;
  readonly historyComplete: boolean;
}

/** Retain one onStart identity and durably consume any fresh-Agent first-use claim. */
export const startQualificationRuntimeActivation = (
  db: AgentDb,
  input: { readonly activationId: string; readonly deploymentVersionId: string | null },
) =>
  Effect.try({
    try: () =>
      db.transaction((transaction) => {
        const inserted = transaction
          .insert(qualificationRuntimeActivations)
          .values({
            activation_id: input.activationId,
            deployment_version_id: input.deploymentVersionId,
          })
          .onConflictDoNothing()
          .returning({
            activationId: qualificationRuntimeActivations.activation_id,
            deploymentVersionId: qualificationRuntimeActivations.deployment_version_id,
          })
          .get();
        const retained =
          inserted ??
          transaction
            .select({
              activationId: qualificationRuntimeActivations.activation_id,
              deploymentVersionId: qualificationRuntimeActivations.deployment_version_id,
            })
            .from(qualificationRuntimeActivations)
            .where(eq(qualificationRuntimeActivations.activation_id, input.activationId))
            .limit(1)
            .get();
        if (retained?.deploymentVersionId !== input.deploymentVersionId) {
          return { _tag: "Conflict" as const };
        }
        const state = transaction
          .select({
            firstUseEligible: qualificationActivationState.first_use_eligible,
            requestCount: qualificationActivationState.request_count,
          })
          .from(qualificationActivationState)
          .where(eq(qualificationActivationState.singleton_key, "agent"))
          .limit(1)
          .get();
        const firstUseClaimed =
          state !== undefined && state.firstUseEligible && state.requestCount === 0;
        if (firstUseClaimed) {
          transaction
            .update(qualificationActivationState)
            .set({ first_use_eligible: false })
            .where(eq(qualificationActivationState.singleton_key, "agent"))
            .run();
        }
        return {
          _tag: "Ready" as const,
          claim: {
            ...input,
            firstUseClaimed,
            historyComplete: state !== undefined,
          } satisfies QualificationRuntimeActivationClaim,
        };
      }),
    catch: (cause) =>
      new QualificationActivationStoreUnavailable({
        cause,
        message: "The Agent runtime activation could not be retained",
      }),
  }).pipe(
    Effect.flatMap((outcome) =>
      outcome._tag === "Ready"
        ? Effect.succeed(outcome.claim)
        : Effect.fail(
            new QualificationActivationConflict({
              identity: input.activationId,
              message: "The runtime activation conflicts with its retained deployment identity",
            }),
          ),
    ),
  );

/** Record one admitted request before any Think or provider continuation can execute. */
export const retainAdmittedRequestActivation = (
  db: AgentDb,
  input: {
    readonly activationId: string;
    readonly deploymentVersionId: string | null;
    readonly firstUseClaimed: boolean;
    readonly historyComplete: boolean;
    readonly requestId: string;
    readonly sessionId: string;
  },
) =>
  Effect.try({
    try: () =>
      db.transaction((transaction) => {
        const runtime = transaction
          .select({
            activationId: qualificationRuntimeActivations.activation_id,
            deploymentVersionId: qualificationRuntimeActivations.deployment_version_id,
          })
          .from(qualificationRuntimeActivations)
          .where(eq(qualificationRuntimeActivations.activation_id, input.activationId))
          .limit(1)
          .get();
        if (runtime?.deploymentVersionId !== input.deploymentVersionId) {
          return { _tag: "Conflict" as const };
        }
        const existing = transaction
          .select(admittedRequestFields)
          .from(qualificationAdmittedRequestActivations)
          .where(eq(qualificationAdmittedRequestActivations.request_id, input.requestId))
          .limit(1)
          .get();
        if (existing !== undefined) {
          const retained = decodeAdmittedRequest(existing);
          return exactAdmittedRequest(retained, input)
            ? { _tag: "Ready" as const, retained }
            : { _tag: "Conflict" as const };
        }
        const state = transaction
          .select({
            lastActivationId: qualificationActivationState.last_activation_id,
            lastDeploymentVersionId: qualificationActivationState.last_deployment_version_id,
            requestCount: qualificationActivationState.request_count,
          })
          .from(qualificationActivationState)
          .where(eq(qualificationActivationState.singleton_key, "agent"))
          .limit(1)
          .get();
        const cause = qualificationActivationCause({
          currentActivationId: input.activationId,
          currentDeploymentVersionId: input.deploymentVersionId,
          firstUseClaimed: input.firstUseClaimed,
          historyComplete: input.historyComplete,
          state: state ?? null,
        });
        const classification = cause === null ? null : cause === "warm" ? "warm" : "cold";
        const inserted = transaction
          .insert(qualificationAdmittedRequestActivations)
          .values({
            activation_id: input.activationId,
            cause,
            classification,
            deployment_version_id: input.deploymentVersionId,
            request_id: input.requestId,
            session_id: SessionId.make(input.sessionId),
          })
          .returning(admittedRequestFields)
          .get();
        if (state === undefined) {
          transaction
            .insert(qualificationActivationState)
            .values({
              first_use_eligible: false,
              last_activation_id: input.activationId,
              last_deployment_version_id: input.deploymentVersionId,
              request_count: 1,
              singleton_key: "agent",
            })
            .run();
        } else {
          transaction
            .update(qualificationActivationState)
            .set({
              first_use_eligible: false,
              last_activation_id: input.activationId,
              last_deployment_version_id: input.deploymentVersionId,
              request_count: state.requestCount + 1,
            })
            .where(eq(qualificationActivationState.singleton_key, "agent"))
            .run();
        }
        return { _tag: "Ready" as const, retained: decodeAdmittedRequest(inserted) };
      }),
    catch: (cause) =>
      new QualificationActivationStoreUnavailable({
        cause,
        message: "The admitted request activation could not be retained",
      }),
  }).pipe(
    Effect.flatMap((outcome) =>
      outcome._tag === "Ready"
        ? Effect.succeed(outcome.retained)
        : Effect.fail(
            new QualificationActivationConflict({
              identity: input.requestId,
              message: "The admitted request conflicts with retained activation authority",
            }),
          ),
    ),
  );

const activationReceipt = (input: {
  readonly admission: QualificationAdmissionReceipt;
  readonly observation: QualificationAdmittedRequestActivation;
  readonly region: "americas" | "asiaPacific" | "europe";
}): QualificationActivationReceipt => {
  const productFactId = qualificationChecksum({
    activationId: input.observation.activationId,
    attemptId: input.admission.attemptId,
    executionId: input.admission.executionId,
    rootId: input.admission.rootId,
    sessionId: input.observation.sessionId,
  });
  const content = {
    activationId: input.observation.activationId,
    attemptId: input.admission.attemptId,
    cause: input.observation.cause,
    classification: input.observation.classification,
    deploymentVersionId: input.observation.deploymentVersionId,
    executionId: input.admission.executionId,
    occurredAt: input.observation.observedAt,
    planChecksum: input.admission.planChecksum,
    productFactId,
    region: input.region,
    requestId: input.observation.requestId,
    rootId: input.admission.rootId,
    runId: input.admission.runId,
    sessionId: input.observation.sessionId,
  };
  return { ...content, artifactChecksum: qualificationChecksum(content) };
};

/** Atomically bind an accepted qualification admission to its observed Agent activation. */
export const retainQualificationAdmissionActivation = (
  db: AgentDb,
  input: {
    readonly admission: QualificationAdmissionReceipt;
    readonly region: "americas" | "asiaPacific" | "europe";
    readonly requestId: string;
  },
) =>
  Effect.try({
    try: () =>
      db.transaction((transaction) => {
        const observationRow = transaction
          .select(admittedRequestFields)
          .from(qualificationAdmittedRequestActivations)
          .where(eq(qualificationAdmittedRequestActivations.request_id, input.requestId))
          .limit(1)
          .get();
        if (observationRow === undefined) return { _tag: "Conflict" as const };
        const observation = decodeAdmittedRequest(observationRow);
        if (
          input.admission.admissionDecision !== "accepted" ||
          input.admission.thinkSubmissionId === null ||
          input.admission.thinkSubmissionId !== input.requestId
        ) {
          return { _tag: "Conflict" as const };
        }
        const expectedActivation = activationReceipt({
          admission: input.admission,
          observation,
          region: input.region,
        });
        const retainedAdmission = transaction
          .select(admissionFields)
          .from(qualificationAdmissions)
          .where(eq(qualificationAdmissions.attempt_id, input.admission.attemptId))
          .limit(1)
          .get();
        const retainedActivation = transaction
          .select(activationReceiptFields)
          .from(qualificationActivationReceipts)
          .where(eq(qualificationActivationReceipts.attempt_id, input.admission.attemptId))
          .limit(1)
          .get();
        if (
          (retainedAdmission !== undefined &&
            Schema.decodeSync(QualificationAdmissionReceipt)(retainedAdmission).artifactChecksum !==
              input.admission.artifactChecksum) ||
          (retainedActivation !== undefined &&
            Schema.decodeSync(QualificationActivationReceipt)(retainedActivation)
              .artifactChecksum !== expectedActivation.artifactChecksum)
        ) {
          return { _tag: "Conflict" as const };
        }
        if (retainedAdmission === undefined) {
          transaction
            .insert(qualificationAdmissions)
            .values({
              acceptance_receipt_id: input.admission.acceptanceReceiptId,
              admission_decision: input.admission.admissionDecision,
              agent_id: input.admission.agentId,
              artifact_checksum: input.admission.artifactChecksum,
              attempt_id: input.admission.attemptId,
              execution_id: input.admission.executionId,
              occurred_at: input.admission.occurredAt,
              plan_checksum: input.admission.planChecksum,
              product_fact_id: input.admission.productFactId,
              root_id: input.admission.rootId,
              run_id: input.admission.runId,
              think_submission_id:
                input.admission.thinkSubmissionId === null
                  ? null
                  : ThinkSubmissionId.make(input.admission.thinkSubmissionId),
              user_message_id: input.admission.userMessageId,
              user_update_id: input.admission.userUpdateId,
            })
            .run();
        }
        if (retainedActivation === undefined) {
          transaction
            .insert(qualificationActivationReceipts)
            .values({
              activation_id: expectedActivation.activationId,
              artifact_checksum: expectedActivation.artifactChecksum,
              attempt_id: expectedActivation.attemptId,
              cause: expectedActivation.cause,
              classification: expectedActivation.classification,
              deployment_version_id: expectedActivation.deploymentVersionId,
              execution_id: expectedActivation.executionId,
              occurred_at: expectedActivation.occurredAt,
              plan_checksum: expectedActivation.planChecksum,
              product_fact_id: expectedActivation.productFactId,
              region: expectedActivation.region,
              request_id: expectedActivation.requestId,
              root_id: expectedActivation.rootId,
              run_id: expectedActivation.runId,
              session_id: SessionId.make(expectedActivation.sessionId),
            })
            .run();
        }
        return { _tag: "Ready" as const, receipt: expectedActivation };
      }),
    catch: (cause) =>
      new QualificationActivationStoreUnavailable({
        cause,
        message: "Qualification admission and activation authority could not be committed",
      }),
  }).pipe(
    Effect.flatMap((outcome) =>
      outcome._tag === "Ready"
        ? Effect.succeed(outcome.receipt)
        : Effect.fail(
            new QualificationActivationConflict({
              identity: input.admission.attemptId,
              message: "Qualification activation authority conflicts with the admitted root",
            }),
          ),
    ),
  );

const decodeActivationReceipt = (value: typeof QualificationActivationReceipt.Encoded) =>
  Schema.decodeEffect(QualificationActivationReceipt)(value).pipe(
    Effect.mapError(
      () =>
        new QualificationActivationConflict({
          identity: value.attemptId,
          message: "Retained qualification activation authority is invalid",
        }),
    ),
    Effect.filterOrFail(
      (receipt) => {
        const { artifactChecksum, ...content } = receipt;
        return artifactChecksum === qualificationChecksum(content);
      },
      () =>
        new QualificationActivationConflict({
          identity: "checksum",
          message: "Retained qualification activation authority checksum is invalid",
        }),
    ),
  );

/** Read activation authority for one exact execution and Session in stable root order. */
export const readQualificationActivationReceipts = (
  db: AgentDb,
  input: { readonly executionId: string; readonly sessionId: string },
) =>
  Effect.try({
    try: () =>
      db
        .select(activationReceiptFields)
        .from(qualificationActivationReceipts)
        .where(
          and(
            eq(qualificationActivationReceipts.execution_id, input.executionId),
            eq(qualificationActivationReceipts.session_id, SessionId.make(input.sessionId)),
          ),
        )
        .orderBy(
          asc(qualificationActivationReceipts.run_id),
          asc(qualificationActivationReceipts.occurred_at),
          asc(qualificationActivationReceipts.root_id),
        )
        .all(),
    catch: (cause) =>
      new QualificationActivationStoreUnavailable({
        cause,
        message: "Qualification activation authority could not be read",
      }),
  }).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeActivationReceipt)));
