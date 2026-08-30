import { and, asc, eq } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";

import { SessionId, ThinkSubmissionId } from "../../../domain";
import type { QualificationContext } from "../../../domain/qualification-context";
import { QualificationAdmissionReceipt } from "../../../qualification/qualification-attempt";
import { qualificationChecksum } from "../../../qualification/qualification-checksum";
import {
  QualificationControlledAgentAbortArm,
  qualificationControlledAgentAbortOperationId,
  qualificationControlledAgentRecoveryReceipt,
  type QualificationControlledAgentAbort,
  type QualificationControlledAgentAbortApplied,
  type QualificationControlledAgentRecoveryReceipt,
} from "../../../qualification/controlled-agent-fault";
import type { AgentDb } from "./client";
import {
  qualificationActivationReceipts,
  qualificationActivationState,
  qualificationAdmissions,
  qualificationAdmittedRequestActivations,
  qualificationControlledAgentAborts,
  qualificationRuntimeActivations,
} from "./schema";

/* oxlint-disable eslint/no-underscore-dangle -- Closed activation outcomes use the repository-standard _tag discriminator. */

export type QualificationActivationCause = "deployment" | "faultRecovery" | "firstUse" | "warm";

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
  cause: Schema.NullOr(Schema.Literals(["deployment", "faultRecovery", "firstUse", "warm"])),
  classification: Schema.NullOr(Schema.Literals(["cold", "warm"])),
  controllerOperationId: Schema.NullOr(identity),
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
  cause: Schema.NullOr(Schema.Literals(["deployment", "faultRecovery", "firstUse", "warm"])),
  classification: Schema.NullOr(Schema.Literals(["cold", "warm"])),
  controllerOperationId: Schema.NullOr(identity),
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
  controllerOperationId: qualificationAdmittedRequestActivations.controller_operation_id,
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
  controllerOperationId: qualificationActivationReceipts.controller_operation_id,
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

const controlledAbortFields = {
  applicationAuthorityFactId: qualificationControlledAgentAborts.application_authority_fact_id,
  appliedAt: qualificationControlledAgentAborts.applied_at,
  armedActivationId: qualificationControlledAgentAborts.armed_activation_id,
  armedAt: qualificationControlledAgentAborts.armed_at,
  artifactChecksum: qualificationControlledAgentAborts.artifact_checksum,
  attemptId: qualificationControlledAgentAborts.attempt_id,
  controllerOperationId: qualificationControlledAgentAborts.controller_operation_id,
  executionId: qualificationControlledAgentAborts.execution_id,
  journey: qualificationControlledAgentAborts.journey,
  manifestChecksum: qualificationControlledAgentAborts.manifest_checksum,
  offeredAtEpochMs: qualificationControlledAgentAborts.offered_at_epoch_ms,
  planChecksum: qualificationControlledAgentAborts.plan_checksum,
  proofArtifactChecksum: qualificationControlledAgentAborts.proof_artifact_checksum,
  proofArtifactId: qualificationControlledAgentAborts.proof_artifact_id,
  recoveredActivationId: qualificationControlledAgentAborts.recovered_activation_id,
  recoveryArtifactChecksum: qualificationControlledAgentAborts.recovery_artifact_checksum,
  recoveredAt: qualificationControlledAgentAborts.recovered_at,
  region: qualificationControlledAgentAborts.region,
  requestId: qualificationControlledAgentAborts.request_id,
  restorationAuthorityFactId: qualificationControlledAgentAborts.restoration_authority_fact_id,
  rootId: qualificationControlledAgentAborts.root_id,
  runId: qualificationControlledAgentAborts.run_id,
  sessionId: qualificationControlledAgentAborts.session_id,
  state: qualificationControlledAgentAborts.state,
};

interface AdmittedRequestRow {
  readonly activationId: string;
  readonly cause: QualificationActivationCause | null;
  readonly classification: "cold" | "warm" | null;
  readonly controllerOperationId: string | null;
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
    readonly qualificationContext?: QualificationContext;
  },
): boolean =>
  retained.activationId === input.activationId &&
  retained.deploymentVersionId === input.deploymentVersionId &&
  retained.requestId === input.requestId &&
  retained.sessionId === input.sessionId &&
  retained.controllerOperationId ===
    (input.qualificationContext === undefined
      ? null
      : qualificationControlledAgentAbortOperationId(input.qualificationContext));

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
    readonly qualificationContext?: QualificationContext;
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
        const expectedOperationId =
          input.qualificationContext === undefined
            ? null
            : qualificationControlledAgentAbortOperationId(input.qualificationContext);
        const recovered = transaction
          .select(controlledAbortFields)
          .from(qualificationControlledAgentAborts)
          .where(
            and(
              eq(qualificationControlledAgentAborts.recovered_activation_id, input.activationId),
              eq(qualificationControlledAgentAborts.session_id, SessionId.make(input.sessionId)),
              eq(qualificationControlledAgentAborts.state, "recovered"),
            ),
          )
          .all();
        const exactRecovery = recovered.find(
          (candidate) =>
            expectedOperationId !== null &&
            candidate.controllerOperationId === expectedOperationId &&
            candidate.attemptId === input.qualificationContext?.attemptId &&
            candidate.executionId === input.qualificationContext.executionId &&
            candidate.planChecksum === input.qualificationContext.planChecksum &&
            candidate.rootId === input.qualificationContext.rootId &&
            candidate.runId === input.qualificationContext.runId,
        );
        const inferredCause = qualificationActivationCause({
          currentActivationId: input.activationId,
          currentDeploymentVersionId: input.deploymentVersionId,
          firstUseClaimed: input.firstUseClaimed,
          historyComplete: input.historyComplete,
          state: state ?? null,
        });
        const cause = exactRecovery === undefined ? inferredCause : "faultRecovery";
        const controllerOperationId = exactRecovery?.controllerOperationId ?? null;
        const classification = cause === null ? null : cause === "warm" ? "warm" : "cold";
        for (const candidate of recovered) {
          transaction
            .update(qualificationControlledAgentAborts)
            .set({
              request_id: input.requestId,
              state:
                candidate.controllerOperationId === controllerOperationId
                  ? "consumed"
                  : "interfered",
            })
            .where(
              eq(
                qualificationControlledAgentAborts.controller_operation_id,
                candidate.controllerOperationId,
              ),
            )
            .run();
        }
        const inserted = transaction
          .insert(qualificationAdmittedRequestActivations)
          .values({
            activation_id: input.activationId,
            cause,
            classification,
            controller_operation_id: controllerOperationId,
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

interface ControlledAbortProjection {
  readonly applicationAuthorityFactId: string | null;
  readonly appliedAt: string | null;
  readonly armedActivationId: string;
  readonly armedAt: string;
  readonly artifactChecksum: string;
  readonly attemptId: string;
  readonly controllerOperationId: string;
  readonly executionId: string;
  readonly journey: QualificationContext["journey"];
  readonly manifestChecksum: string;
  readonly offeredAtEpochMs: number;
  readonly planChecksum: string;
  readonly proofArtifactChecksum: string;
  readonly proofArtifactId: string;
  readonly recoveredActivationId: string | null;
  readonly recoveryArtifactChecksum: string | null;
  readonly recoveredAt: string | null;
  readonly region: QualificationContext["region"];
  readonly requestId: string | null;
  readonly restorationAuthorityFactId: string | null;
  readonly rootId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly state: "armed" | "consumed" | "interfered" | "recovered";
}

const controlledAbortArmFromRow = (
  row: ControlledAbortProjection,
): QualificationControlledAgentAbortArm | null => {
  const decoded = Schema.decodeOption(QualificationControlledAgentAbortArm)({
    armedActivationId: row.armedActivationId,
    armedAtUtc: sqliteUtc(row.armedAt),
    artifactChecksum: row.artifactChecksum,
    context: {
      attemptId: row.attemptId,
      executionId: row.executionId,
      journey: row.journey,
      offeredAtEpochMs: row.offeredAtEpochMs,
      planChecksum: row.planChecksum,
      region: row.region,
      rootId: row.rootId,
      runId: row.runId,
    },
    controllerOperationId: row.controllerOperationId,
    manifestChecksum: row.manifestChecksum,
    proofArtifactChecksum: row.proofArtifactChecksum,
    proofArtifactId: row.proofArtifactId,
    sessionId: row.sessionId,
  });
  if (decoded._tag === "None") return null;
  const { artifactChecksum, ...content } = decoded.value;
  return artifactChecksum === qualificationChecksum(content) ? decoded.value : null;
};

const controlledRecoveryFromRow = (
  row: ControlledAbortProjection,
): QualificationControlledAgentRecoveryReceipt | null => {
  if (
    row.applicationAuthorityFactId === null ||
    row.appliedAt === null ||
    row.recoveredActivationId === null ||
    row.recoveryArtifactChecksum === null ||
    row.recoveredAt === null ||
    row.restorationAuthorityFactId === null
  ) {
    return null;
  }
  const receipt = qualificationControlledAgentRecoveryReceipt({
    applicationAuthorityFactId: row.applicationAuthorityFactId,
    appliedAtUtc: sqliteUtc(row.appliedAt),
    armedActivationId: row.armedActivationId,
    controllerOperationId: row.controllerOperationId,
    executionId: row.executionId,
    manifestChecksum: row.manifestChecksum,
    planChecksum: row.planChecksum,
    recoveredActivationId: row.recoveredActivationId,
    recoveredAtUtc: sqliteUtc(row.recoveredAt),
    rootId: row.rootId,
    runId: row.runId,
  });
  return receipt.artifactChecksum === row.recoveryArtifactChecksum &&
    receipt.restorationAuthorityFactId === row.restorationAuthorityFactId
    ? receipt
    : null;
};

/** Arm one exact currently-running Agent activation before its parent may abort it. */
export const armQualificationControlledAgentAbort = (
  db: AgentDb,
  input: { readonly activationId: string; readonly command: QualificationControlledAgentAbort },
) =>
  Effect.try({
    try: () =>
      db.transaction((transaction) => {
        if (
          input.command.controllerOperationId !==
          qualificationControlledAgentAbortOperationId(input.command.context)
        ) {
          return { _tag: "Conflict" as const };
        }
        const existing = transaction
          .select(controlledAbortFields)
          .from(qualificationControlledAgentAborts)
          .where(
            eq(
              qualificationControlledAgentAborts.controller_operation_id,
              input.command.controllerOperationId,
            ),
          )
          .limit(1)
          .get();
        if (existing !== undefined) {
          const arm = controlledAbortArmFromRow(existing);
          return arm !== null &&
            arm.armedActivationId === input.activationId &&
            qualificationChecksum({
              context: arm.context,
              controllerOperationId: arm.controllerOperationId,
              manifestChecksum: arm.manifestChecksum,
              proofArtifactChecksum: arm.proofArtifactChecksum,
              proofArtifactId: arm.proofArtifactId,
              sessionId: arm.sessionId,
            }) === qualificationChecksum(input.command)
            ? { _tag: "Ready" as const, arm }
            : { _tag: "Conflict" as const };
        }
        const inserted = transaction
          .insert(qualificationControlledAgentAborts)
          .values({
            armed_activation_id: input.activationId,
            artifact_checksum: "pending",
            attempt_id: input.command.context.attemptId,
            controller_operation_id: input.command.controllerOperationId,
            execution_id: input.command.context.executionId,
            journey: input.command.context.journey,
            manifest_checksum: input.command.manifestChecksum,
            offered_at_epoch_ms: input.command.context.offeredAtEpochMs,
            plan_checksum: input.command.context.planChecksum,
            proof_artifact_checksum: input.command.proofArtifactChecksum,
            proof_artifact_id: input.command.proofArtifactId,
            region: input.command.context.region,
            root_id: input.command.context.rootId,
            run_id: input.command.context.runId,
            session_id: SessionId.make(input.command.sessionId),
            state: "armed",
          })
          .returning(controlledAbortFields)
          .get();
        const armedAtUtc = sqliteUtc(inserted.armedAt);
        const content = {
          ...input.command,
          armedActivationId: input.activationId,
          armedAtUtc,
        };
        const arm = QualificationControlledAgentAbortArm.make({
          ...content,
          artifactChecksum: qualificationChecksum(content),
        });
        transaction
          .update(qualificationControlledAgentAborts)
          .set({ artifact_checksum: arm.artifactChecksum })
          .where(
            eq(
              qualificationControlledAgentAborts.controller_operation_id,
              input.command.controllerOperationId,
            ),
          )
          .run();
        return { _tag: "Ready" as const, arm };
      }),
    catch: (cause) =>
      new QualificationActivationStoreUnavailable({
        cause,
        message: "The controlled Agent abort could not be armed",
      }),
  }).pipe(
    Effect.flatMap((outcome) =>
      outcome._tag === "Ready"
        ? Effect.succeed(outcome.arm)
        : Effect.fail(
            new QualificationActivationConflict({
              identity: input.command.controllerOperationId,
              message: "The controlled Agent abort conflicts with retained authority",
            }),
          ),
    ),
  );

/** Authorize one exact root only after the parent proved an applied abort and a new activation. */
export const recoverQualificationControlledAgentAbort = (
  db: AgentDb,
  input: {
    readonly applied: QualificationControlledAgentAbortApplied;
    readonly recoveredActivationId: string;
  },
) =>
  Effect.try({
    try: () =>
      db.transaction((transaction) => {
        const row = transaction
          .select(controlledAbortFields)
          .from(qualificationControlledAgentAborts)
          .where(
            eq(
              qualificationControlledAgentAborts.controller_operation_id,
              input.applied.controllerOperationId,
            ),
          )
          .limit(1)
          .get();
        const arm = row === undefined ? null : controlledAbortArmFromRow(row);
        if (
          arm === null ||
          arm.armedActivationId !== input.applied.armedActivationId ||
          input.recoveredActivationId === arm.armedActivationId ||
          qualificationChecksum({
            context: arm.context,
            controllerOperationId: arm.controllerOperationId,
            manifestChecksum: arm.manifestChecksum,
            proofArtifactChecksum: arm.proofArtifactChecksum,
            proofArtifactId: arm.proofArtifactId,
            sessionId: arm.sessionId,
          }) !==
            qualificationChecksum({
              context: input.applied.context,
              controllerOperationId: input.applied.controllerOperationId,
              manifestChecksum: input.applied.manifestChecksum,
              proofArtifactChecksum: input.applied.proofArtifactChecksum,
              proofArtifactId: input.applied.proofArtifactId,
              sessionId: input.applied.sessionId,
            }) ||
          row?.state === "interfered"
        ) {
          return { _tag: "Conflict" as const };
        }
        if (row?.state === "recovered" || row?.state === "consumed") {
          return row.applicationAuthorityFactId === input.applied.applicationAuthorityFactId &&
            row.recoveredActivationId === input.recoveredActivationId
            ? { _tag: "Ready" as const }
            : { _tag: "Conflict" as const };
        }
        const recoveredActivation = transaction
          .select({ startedAt: qualificationRuntimeActivations.started_at })
          .from(qualificationRuntimeActivations)
          .where(eq(qualificationRuntimeActivations.activation_id, input.recoveredActivationId))
          .limit(1)
          .get();
        if (recoveredActivation === undefined) return { _tag: "Conflict" as const };
        const recoveredAtUtc = sqliteUtc(recoveredActivation.startedAt);
        const receipt = qualificationControlledAgentRecoveryReceipt({
          applicationAuthorityFactId: input.applied.applicationAuthorityFactId,
          appliedAtUtc: input.applied.appliedAtUtc,
          armedActivationId: input.applied.armedActivationId,
          controllerOperationId: input.applied.controllerOperationId,
          executionId: input.applied.context.executionId,
          manifestChecksum: input.applied.manifestChecksum,
          planChecksum: input.applied.context.planChecksum,
          recoveredActivationId: input.recoveredActivationId,
          recoveredAtUtc,
          rootId: input.applied.context.rootId,
          runId: input.applied.context.runId,
        });
        transaction
          .update(qualificationControlledAgentAborts)
          .set({
            application_authority_fact_id: receipt.applicationAuthorityFactId,
            applied_at: receipt.appliedAtUtc,
            recovered_activation_id: receipt.recoveredActivationId,
            recovery_artifact_checksum: receipt.artifactChecksum,
            recovered_at: receipt.recoveredAtUtc,
            restoration_authority_fact_id: receipt.restorationAuthorityFactId,
            state: "recovered",
          })
          .where(
            eq(
              qualificationControlledAgentAborts.controller_operation_id,
              input.applied.controllerOperationId,
            ),
          )
          .run();
        return { _tag: "Ready" as const };
      }),
    catch: (cause) =>
      new QualificationActivationStoreUnavailable({
        cause,
        message: "The controlled Agent recovery could not be retained",
      }),
  }).pipe(
    Effect.flatMap((outcome) =>
      outcome._tag === "Ready"
        ? Effect.void
        : Effect.fail(
            new QualificationActivationConflict({
              identity: input.applied.controllerOperationId,
              message: "The controlled Agent recovery conflicts with retained authority",
            }),
          ),
    ),
  );

/** Inspect an armed/recovered token so the parent can reconcile an ambiguous abort safely. */
export const inspectQualificationControlledAgentAbort = (
  db: AgentDb,
  controllerOperationId: string,
): Effect.Effect<
  {
    readonly arm: QualificationControlledAgentAbortArm;
    readonly recovery: QualificationControlledAgentRecoveryReceipt | null;
    readonly state: "armed" | "consumed" | "interfered" | "recovered";
  } | null,
  QualificationActivationStoreUnavailable | QualificationActivationConflict
> =>
  Effect.try({
    try: () =>
      db
        .select(controlledAbortFields)
        .from(qualificationControlledAgentAborts)
        .where(
          eq(qualificationControlledAgentAborts.controller_operation_id, controllerOperationId),
        )
        .limit(1)
        .get(),
    catch: (cause) =>
      new QualificationActivationStoreUnavailable({
        cause,
        message: "Controlled Agent abort authority could not be inspected",
      }),
  }).pipe(
    Effect.flatMap((row) => {
      if (row === undefined) return Effect.succeed(null);
      const arm = controlledAbortArmFromRow(row);
      return arm === null
        ? Effect.fail(
            new QualificationActivationConflict({
              identity: controllerOperationId,
              message: "Controlled Agent abort authority is malformed",
            }),
          )
        : Effect.succeed({ arm, recovery: controlledRecoveryFromRow(row), state: row.state });
    }),
  );

/** Read one consumed recovery fact. Recovered but unconsumed tokens are not evidence. */
export const readQualificationControlledAgentRecovery = (
  db: AgentDb,
  controllerOperationId: string,
): Effect.Effect<
  QualificationControlledAgentRecoveryReceipt | null,
  QualificationActivationStoreUnavailable | QualificationActivationConflict
> =>
  Effect.try({
    try: () =>
      db
        .select(controlledAbortFields)
        .from(qualificationControlledAgentAborts)
        .where(
          eq(qualificationControlledAgentAborts.controller_operation_id, controllerOperationId),
        )
        .limit(1)
        .get(),
    catch: (cause) =>
      new QualificationActivationStoreUnavailable({
        cause,
        message: "Controlled Agent recovery authority could not be read",
      }),
  }).pipe(
    Effect.flatMap((row) => {
      if (row === undefined || row.state !== "consumed") return Effect.succeed(null);
      const receipt = controlledRecoveryFromRow(row);
      if (receipt === null) {
        return Effect.fail(
          new QualificationActivationConflict({
            identity: controllerOperationId,
            message: "Consumed controlled Agent recovery authority is incomplete",
          }),
        );
      }
      return Effect.succeed(receipt);
    }),
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
    controllerOperationId: input.observation.controllerOperationId,
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
              controller_operation_id: expectedActivation.controllerOperationId,
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
