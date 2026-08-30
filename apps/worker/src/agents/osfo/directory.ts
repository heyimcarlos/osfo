import { BrowserCrypto } from "@effect/platform-browser";
import { Think, type StreamCallback, type ThinkChannels } from "@cloudflare/think";
import type { MessengerContext } from "@cloudflare/think/messengers";
import type { UIMessage } from "ai";
import type { SkillChangeRequest, SkillDeletionRequest } from "@osfo/api";
import { Effect, Layer, Option, Redacted, Result, Schema } from "effect";

import { loadConfig } from "../../config";
import { ResearchReportComposition } from "../../composition/research-report";
import { DocumentBuildComposition } from "../../composition/document-build";
import { ScheduledEmailComposition } from "../../composition/scheduled-email";
import { Db } from "../../db";
import { makeTelegramChannel } from "../../integrations/telegram";
import { makeWhatsAppChannel } from "../../integrations/whatsapp";
import { invalidOsfoEnvironment, type RuntimeProbeResult } from "../../layers";
import type { RuntimeSecrets } from "../../runtime-secrets";
import { AgentDirectory } from "../../services/agent-directory";
import { ChannelLinks } from "../../services/channel-links";
import { ResearchReportFollowUp } from "../../services/research-report-follow-up";
import { DocumentBuild } from "../../services/document-build";
import { DocumentBuildFollowUp } from "../../services/document-build-follow-up";
import { ScheduledEmail } from "../../services/scheduled-email";
import { ScheduledEmailFollowUp } from "../../services/scheduled-email-follow-up";
import { OsfoAgent } from "./agent";
import { channelAddressOf, messengerAuthorId } from "./channel-address";
import { streamTextReply } from "./messenger-stream";
import { makeOsfoMessengerRouter, type MessengerAddressResolution } from "./messenger-routing";
import type { AgentInitializationEncoded } from "./db/store";
import { GroupRefusalCopy } from "./persona";
import { UserId } from "../../domain";
import { AuthSessionId } from "../../domain/auth-session";
import { WebFileUpload } from "./web-file-upload";
import { DocumentBuildFileResolution } from "./document-build-file-resolution";
import type { DecideActionApprovalRequest } from "./think-action-approvals";
import type { SubmitQualificationConversationRequest } from "../../qualification/qualification-attempt";
import {
  QualificationControlledAgentAbort,
  QualificationControlledAgentAbortApplied,
  qualificationControlledAgentAbortOperationId,
  qualificationControlledAgentAbortReconciliation,
  qualificationControlledAgentFaultDeletionFenced,
  qualificationControlledAgentFaultControllerRecord,
  validQualificationControlledAgentFaultControllerRecord,
  type QualificationControlledAgentFaultControllerRecord,
} from "../../qualification/controlled-agent-fault";
import { qualificationChecksum } from "../../qualification/qualification-checksum";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/strict-effect-provide, eslint/no-underscore-dangle, osfo/no-unknown-parameters -- Think RPC methods receive untrusted payloads, immediately schema-decode them, and retain host-observed controller time at this messenger composition root. */

export { OSFO_DIRECTORY_NAME } from "./identity";

/** Root Agent that owns the registry of user-scoped Osfo Agent facets. */
export class OsfoDirectory extends Think<Env & RuntimeSecrets> {
  /** Keep the directory model dormant. User turns run only on child facets. */
  override getModel() {
    return "@cf/openai/gpt-oss-120b";
  }

  /** Configure the shared messenger webhooks and their conversation resolvers. */
  override configureChannels(): ThinkChannels {
    const config = loadConfig(this.env);
    const conversation = makeOsfoMessengerRouter({
      hasAgent: (agentId) => this.hasSubAgent(OsfoAgent, agentId),
      resolveAddress: (address) =>
        Effect.scoped(
          this.#resolveMessengerAddress(address).pipe(
            Effect.provide(directoryMessengerLayer(this.env)),
          ),
        ),
    });
    return {
      telegram: makeTelegramChannel({
        apiBaseURL: config.telegram.apiBaseURL,
        conversation,
        secretToken: Redacted.value(config.telegram.webhookSecret),
        token: Redacted.value(config.telegram.botToken),
        userName: config.telegram.botUsername,
      }),
      whatsapp: makeWhatsAppChannel({
        accessToken: this.env.WHATSAPP_ACCESS_TOKEN,
        apiUrl: config.whatsApp.apiBaseURL,
        appSecret: this.env.WHATSAPP_APP_SECRET,
        conversation,
        phoneNumberId: this.env.WHATSAPP_PHONE_NUMBER_ID,
        userName: this.env.WHATSAPP_BOT_USERNAME,
        verifyToken: this.env.WHATSAPP_VERIFY_TOKEN,
      }),
    };
  }

  /** Deterministically answer the messenger turns that never reach a facet. */
  override chatWithMessengerContext(
    _userMessage: string | UIMessage,
    callback: StreamCallback,
    context: MessengerContext,
  ): Promise<void> {
    return Effect.runPromise(
      Effect.scoped(
        replyToDirectoryGate(callback, context).pipe(
          Effect.provide(directoryMessengerLayer(this.env)),
        ),
      ),
    );
  }

  /** Reject an HTTP route to a facet that is absent from the directory registry. */
  override async onBeforeSubAgent(
    _request: Request,
    target: { readonly className: string; readonly name: string },
  ): Promise<Response | void> {
    if (target.className !== OsfoAgent.name || !this.hasSubAgent(target.className, target.name)) {
      return new Response("Agent not found", { status: 404 });
    }
  }

  /** Create the user-owned facet when necessary and return its registry identity. */
  async ensureAgent(
    agentId: string,
  ): Promise<{ readonly className: string; readonly name: string }> {
    await this.subAgent(OsfoAgent, agentId);
    return { className: OsfoAgent.name, name: agentId };
  }

  /** Initialize one registered user-owned facet. */
  async initializeAgent(agentId: string, input: AgentInitializationEncoded) {
    const agent = await this.subAgent(OsfoAgent, agentId);
    const result = await agent.initialize(input);
    return { _tag: result._tag };
  }

  /** Probe one registered facet runtime for local smoke verification. */
  async probeAgent(agentId: string): Promise<RuntimeProbeResult> {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return invalidOsfoEnvironment;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.probeRuntime();
  }

  /** Inspect one registered user-owned facet without exposing it to a browser. */
  async inspectAgent(agentId: string) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    const result = await agent.inspect();
    return result._tag === "AgentFound"
      ? {
          agentId: result.agentId,
          currentSessionId: result.currentSessionId,
          routeId: result.routeId,
        }
      : null;
  }

  /** Route a proof-bound qualification turn to an already registered User Agent. */
  async submitQualificationConversation(
    agentId: string,
    input: SubmitQualificationConversationRequest,
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) {
      return { _tag: "QualificationAgentNotFound" as const };
    }
    return (await this.subAgent(OsfoAgent, agentId)).submitQualificationConversation(input);
  }

  /** Read producer-owned qualification decisions from one exact registered Agent. */
  async readQualificationAdmissionReceipts(agentId: string, executionId: string) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) {
      return { _tag: "QualificationAgentNotFound" as const };
    }
    return (await this.subAgent(OsfoAgent, agentId)).readQualificationAdmissionReceipts(
      executionId,
    );
  }

  /** Read exact Session-bound activation authority from one registered Agent. */
  async readQualificationActivationReceipts(
    agentId: string,
    executionId: string,
    sessionId: string,
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) {
      return { _tag: "QualificationAgentNotFound" as const };
    }
    return (await this.subAgent(OsfoAgent, agentId)).readQualificationActivationReceipts(
      executionId,
      sessionId,
    );
  }

  /** Apply and reconcile one proof-bound cold-activation abort on a disposable Agent. */
  async applyQualificationControlledAgentAbort(agentId: string, encoded: unknown) {
    const decoded = Schema.decodeUnknownOption(QualificationControlledAgentAbort)(encoded);
    if (
      Option.isNone(decoded) ||
      decoded.value.controllerOperationId !==
        qualificationControlledAgentAbortOperationId(decoded.value.context)
    ) {
      return { _tag: "QualificationControlledAgentFaultConflict" as const };
    }
    const command = decoded.value;
    if (
      !this.hasSubAgent(OsfoAgent, agentId) ||
      (await this.#qualificationFaultDeletionFenced(agentId))
    ) {
      return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
    }
    const key = qualificationControlledAgentFaultKey(agentId, command.controllerOperationId);
    const retained =
      await this.ctx.storage.get<QualificationControlledAgentFaultControllerRecord>(key);
    if (await this.#qualificationFaultDeletionFenced(agentId)) {
      return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
    }
    if (
      retained !== undefined &&
      !validQualificationControlledAgentFaultControllerRecord(retained)
    ) {
      return { _tag: "QualificationControlledAgentFaultConflict" as const };
    }
    if (
      retained !== undefined &&
      (retained.agentId !== agentId ||
        qualificationChecksum(retained.arm.context) !== qualificationChecksum(command.context))
    ) {
      return { _tag: "QualificationControlledAgentFaultConflict" as const };
    }
    let controller = retained;
    if (controller === undefined) {
      const child = await this.#qualificationFaultAgent(agentId);
      if (child === null) {
        return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
      }
      const armed = await child.armQualificationControlledAgentAbort(command);
      if (await this.#qualificationFaultDeletionFenced(agentId)) {
        return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
      }
      if (armed._tag !== "QualificationControlledAgentFaultArmed") return armed;
      const proposed = qualificationControlledAgentFaultControllerRecord({
        agentId,
        applied: null,
        arm: armed.arm,
        state: "armed",
      });
      const retainedArm = await retainControlledAgentFaultRecord(this.ctx.storage, key, proposed);
      if (await this.#qualificationFaultDeletionFenced(agentId)) {
        await this.ctx.storage.delete(key);
        return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
      }
      if (retainedArm === null) {
        return { _tag: "QualificationControlledAgentFaultConflict" as const };
      }
      controller = retainedArm;
    }
    if (controller.state === "ambiguous") {
      return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
    }
    if (controller.state === "armed") {
      const child = await this.#qualificationFaultAgent(agentId);
      if (child === null) {
        return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
      }
      const before = await child.inspectQualificationControlledAgentAbort(
        command.controllerOperationId,
      );
      if (await this.#qualificationFaultDeletionFenced(agentId)) {
        return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
      }
      if (before._tag !== "QualificationControlledAgentFaultState") return before;
      if (
        qualificationControlledAgentAbortReconciliation({
          armedActivationId: controller.arm.armedActivationId,
          observedActivationId: before.activationId,
          retainedState: controller.state,
        }) !== "abortArmedActivation"
      ) {
        const ambiguous = qualificationControlledAgentFaultControllerRecord({
          agentId,
          applied: null,
          arm: controller.arm,
          state: "ambiguous",
        });
        await replaceControlledAgentFaultRecord(
          this.ctx.storage,
          key,
          controller.artifactChecksum,
          ambiguous,
        );
        if (await this.#qualificationFaultDeletionFenced(agentId)) {
          await this.ctx.storage.delete(key);
        }
        return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
      }
      try {
        this.abortSubAgent(
          OsfoAgent,
          agentId,
          new Error("Qualification requested one controlled Agent cold activation"),
        );
      } catch {
        if (await this.#qualificationFaultDeletionFenced(agentId)) {
          return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
        }
        const reconciled = await this.#qualificationFaultAgent(agentId);
        if (reconciled === null) {
          return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
        }
        const reconciledState = await reconciled.inspectQualificationControlledAgentAbort(
          command.controllerOperationId,
        );
        if (
          reconciledState._tag === "QualificationControlledAgentFaultState" &&
          qualificationControlledAgentAbortReconciliation({
            armedActivationId: controller.arm.armedActivationId,
            observedActivationId: reconciledState.activationId,
            retainedState: controller.state,
          }) === "retainMissing" &&
          reconciledState.activationId !== controller.arm.armedActivationId
        ) {
          const ambiguous = qualificationControlledAgentFaultControllerRecord({
            agentId,
            applied: null,
            arm: controller.arm,
            state: "ambiguous",
          });
          await replaceControlledAgentFaultRecord(
            this.ctx.storage,
            key,
            controller.artifactChecksum,
            ambiguous,
          );
          if (await this.#qualificationFaultDeletionFenced(agentId)) {
            await this.ctx.storage.delete(key);
          }
        }
        return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
      }
      const appliedAtUtc = new Date().toISOString();
      const applied = QualificationControlledAgentAbortApplied.make({
        ...command,
        applicationAuthorityFactId: qualificationChecksum({
          armedArtifactChecksum: controller.arm.artifactChecksum,
          controllerOperationId: command.controllerOperationId,
          kind: "facetAbortApplied",
        }),
        appliedAtUtc,
        armedActivationId: controller.arm.armedActivationId,
      });
      const appliedRecord = qualificationControlledAgentFaultControllerRecord({
        agentId,
        applied,
        arm: controller.arm,
        state: "applied",
      });
      const replaced = await replaceControlledAgentFaultRecord(
        this.ctx.storage,
        key,
        controller.artifactChecksum,
        appliedRecord,
      );
      if (await this.#qualificationFaultDeletionFenced(agentId)) {
        await this.ctx.storage.delete(key);
        return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
      }
      if (!replaced) {
        return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
      }
      controller = appliedRecord;
    }
    if (controller.applied === null) {
      return { _tag: "QualificationControlledAgentFaultConflict" as const };
    }
    const restarted = await this.#qualificationFaultAgent(agentId);
    if (restarted === null) {
      return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
    }
    const state = await restarted.inspectQualificationControlledAgentAbort(
      command.controllerOperationId,
    );
    if (await this.#qualificationFaultDeletionFenced(agentId)) {
      return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
    }
    if (state._tag !== "QualificationControlledAgentFaultState") return state;
    if (
      qualificationControlledAgentAbortReconciliation({
        armedActivationId: controller.arm.armedActivationId,
        observedActivationId: state.activationId,
        retainedState: controller.state,
      }) !== "recoverChangedActivation"
    ) {
      return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
    }
    const recovered = await restarted.recoverQualificationControlledAgentAbort(controller.applied);
    if (await this.#qualificationFaultDeletionFenced(agentId)) {
      return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
    }
    if (recovered._tag !== "QualificationControlledAgentFaultRecovered") return recovered;
    const verified = await restarted.inspectQualificationControlledAgentAbort(
      command.controllerOperationId,
    );
    if (await this.#qualificationFaultDeletionFenced(agentId)) {
      return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
    }
    return verified._tag === "QualificationControlledAgentFaultState" &&
      verified.retained?.recovery !== null &&
      verified.retained?.recovery !== undefined
      ? {
          _tag: "QualificationControlledAgentFaultReady" as const,
          appliedAtUtc: verified.retained.recovery.appliedAtUtc,
          controllerOperationId: command.controllerOperationId,
          recoveredAtUtc: verified.retained.recovery.recoveredAtUtc,
        }
      : { _tag: "QualificationControlledAgentFaultUnavailable" as const };
  }

  /** Read the exact per-root recovery authority after admission consumption. */
  async readQualificationControlledAgentRecovery(agentId: string, controllerOperationId: string) {
    if (
      !this.hasSubAgent(OsfoAgent, agentId) ||
      (await this.#qualificationFaultDeletionFenced(agentId))
    ) {
      return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
    }
    const child = await this.#qualificationFaultAgent(agentId);
    return child === null
      ? { _tag: "QualificationControlledAgentFaultUnavailable" as const }
      : child.readQualificationControlledAgentRecovery(controllerOperationId);
  }

  /** Verify the before-offer barrier without ever repeating its abort side effect. */
  async inspectQualificationControlledAgentFaultPreparation(
    agentId: string,
    controllerOperationId: string,
  ) {
    if (await this.#qualificationFaultDeletionFenced(agentId)) {
      return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
    }
    const retained = await this.ctx.storage.get<QualificationControlledAgentFaultControllerRecord>(
      qualificationControlledAgentFaultKey(agentId, controllerOperationId),
    );
    if (await this.#qualificationFaultDeletionFenced(agentId)) {
      return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
    }
    if (!validQualificationControlledAgentFaultControllerRecord(retained)) {
      return retained === undefined
        ? ({ _tag: "QualificationControlledAgentFaultUnavailable" as const } as const)
        : ({ _tag: "QualificationControlledAgentFaultConflict" as const } as const);
    }
    if (retained.state !== "applied" || retained.applied === null) {
      return retained.state === "ambiguous"
        ? ({ _tag: "QualificationControlledAgentFaultUnavailable" as const } as const)
        : ({ _tag: "QualificationControlledAgentFaultConflict" as const } as const);
    }
    const child = await this.#qualificationFaultAgent(agentId);
    if (child === null) {
      return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
    }
    const state = await child.inspectQualificationControlledAgentAbort(controllerOperationId);
    if (await this.#qualificationFaultDeletionFenced(agentId)) {
      return { _tag: "QualificationControlledAgentFaultUnavailable" as const };
    }
    return state._tag === "QualificationControlledAgentFaultState" &&
      state.activationId !== retained.arm.armedActivationId &&
      (state.retained?.state === "recovered" || state.retained?.state === "consumed") &&
      state.retained.recovery !== null
      ? ({
          _tag: "QualificationControlledAgentFaultReady" as const,
          appliedAtUtc: state.retained.recovery.appliedAtUtc,
          controllerOperationId,
          recoveredAtUtc: state.retained.recovery.recoveredAtUtc,
        } as const)
      : state._tag === "QualificationControlledAgentFaultConflict"
        ? state
        : ({ _tag: "QualificationControlledAgentFaultUnavailable" as const } as const);
  }

  /** Read terminal qualification facts from their exact serialized Agent authority. */
  async readQualificationTurnAuthority(agentId: string, executionId: string, sessionId: string) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) {
      return { _tag: "QualificationAgentNotFound" as const };
    }
    return (await this.subAgent(OsfoAgent, agentId)).readQualificationTurnAuthority(
      executionId,
      sessionId,
    );
  }

  /** Inspect one committed Reminder source through its owning User Agent. */
  async inspectReminderWakeUpSource(userId: string, sourceIdentity: string) {
    const agent = await this.#agentForUser(userId);
    return agent === null ? null : agent.inspectReminderWakeUpSource(userId, sourceIdentity);
  }

  /** List Reminder source identities awaiting the User's normal inbound turn. */
  async pendingReminderWakeUpSources(userId: string) {
    const agent = await this.#agentForUser(userId);
    return agent === null ? [] : agent.pendingReminderWakeUpSources(userId);
  }

  /** Resolve Document Build sources through the User's stable owning Agent route. */
  async resolveDocumentBuildFiles(encoded: unknown): Promise<DocumentBuild.FileResolutionResult> {
    const decoded = Schema.decodeUnknownResult(DocumentBuild.FileResolutionRequest)(encoded);
    if (Result.isFailure(decoded)) return { _tag: "Unavailable", reason: "invalidRequest" };
    const request = decoded.success;
    const agent = await this.#agentForUser(request.userId);
    if (agent === null) return { _tag: "Unavailable", reason: "routeMismatch" };
    return agent.resolveDocumentBuildFiles(request);
  }

  /** Route one authenticated browser upload to the stable owning Agent. */
  async uploadUserTextFile(encoded: unknown): Promise<WebFileUpload.Result> {
    const decoded = Schema.decodeUnknownResult(WebFileUpload.Request)(encoded);
    if (Result.isFailure(decoded)) return { _tag: "Rejected", reason: "invalid" };
    const request = decoded.success;
    const agent = await this.#agentForUser(request.authority.userId);
    if (agent === null) return { _tag: "Rejected", reason: "denied" };
    return agent.uploadUserTextFile(request);
  }

  /** Read one privacy-safe browser upload status through its stable owning Agent. */
  async inspectUserFile(encoded: unknown): Promise<WebFileUpload.StatusResult> {
    const decoded = Schema.decodeUnknownResult(WebFileUpload.StatusRequest)(encoded);
    if (Result.isFailure(decoded)) return { _tag: "Unavailable" };
    const request = decoded.success;
    const agent = await this.#agentForUser(request.userId);
    if (agent === null) return { _tag: "Unavailable" };
    return agent.inspectUserFile(request);
  }

  /** Route a read-only source snapshot inspection through the stable owning Agent. */
  async inspectDocumentBuildSourceSnapshot(
    encoded: unknown,
  ): Promise<DocumentBuildFileResolution.VerificationResult> {
    const decoded = Schema.decodeUnknownResult(DocumentBuildFileResolution.VerificationRequest)(
      encoded,
    );
    if (Result.isFailure(decoded)) return { _tag: "Unavailable" };
    const request = decoded.success;
    const agent = await this.#agentForUser(request.userId);
    if (agent === null) return { _tag: "Unavailable" };
    return agent.inspectDocumentBuildSourceSnapshot(request);
  }

  /** Inspect privacy-safe Reminder lifecycle evidence through its owning User Agent. */
  async inspectReminderVerificationState(userId: string) {
    const agent = await this.#agentForUser(userId);
    return agent === null ? null : agent.inspectReminderVerificationState(userId);
  }

  /** Commit an exact Reminder source exposure snapshot in its owning User Agent. */
  async exposeReminderWakeUpSources(
    userId: string,
    // oxlint-disable-next-line osfo/no-unknown-parameters -- The owning Agent schema-decodes this Directory RPC payload before use.
    committed: unknown,
  ): Promise<void> {
    const agent = await this.#agentForUser(userId);
    if (agent === null) return;
    await agent.exposeReminderWakeUpSources(userId, committed);
  }

  /** Route one opaque, PostgreSQL-authorized Research Report follow-up to its exact Agent. */
  async submitResearchReportFollowUp(notificationIdentity: string) {
    const decoded = Schema.decodeResult(ResearchReportFollowUp.NotificationId)(
      notificationIdentity,
    );
    if (Result.isFailure(decoded)) return { _tag: "ResearchReportFollowUpInvalid" as const };
    const notification = await Effect.runPromise(
      ResearchReportComposition.followUpEffect(
        { DB: this.env.DB },
        ResearchReportFollowUp.Service.pipe(
          Effect.flatMap((followUps) => followUps.inspect(decoded.success)),
          Effect.orDie,
        ),
      ),
    );
    if (notification === null || !this.hasSubAgent(OsfoAgent, notification.agentId)) {
      return { _tag: "ResearchReportFollowUpUnavailable" as const };
    }
    const agent = await this.subAgent(OsfoAgent, notification.agentId);
    return agent.submitResearchReportFollowUp(notificationIdentity);
  }

  /** Route one opaque, PostgreSQL-authorized Document Build follow-up to its exact Agent. */
  async submitDocumentBuildFollowUp(notificationIdentity: string) {
    const decoded = Schema.decodeResult(DocumentBuildFollowUp.NotificationId)(notificationIdentity);
    if (Result.isFailure(decoded)) return { _tag: "DocumentBuildFollowUpInvalid" as const };
    const notification = await Effect.runPromise(
      DocumentBuildComposition.followUpEffect(
        { DB: this.env.DB },
        DocumentBuildFollowUp.Service.pipe(
          Effect.flatMap((followUps) => followUps.inspect(decoded.success)),
          Effect.orDie,
        ),
      ),
    );
    if (notification === null || !this.hasSubAgent(OsfoAgent, notification.agentId)) {
      return { _tag: "DocumentBuildFollowUpUnavailable" as const };
    }
    const agent = await this.subAgent(OsfoAgent, notification.agentId);
    return agent.submitDocumentBuildFollowUp(notificationIdentity);
  }

  /** Begin the durable wait through the exact Agent retained by the Workflow payload. */
  async beginScheduledEmail(encoded: unknown) {
    const decoded = Schema.decodeUnknownResult(ScheduledEmail.WorkflowPayload)(encoded);
    if (Result.isFailure(decoded)) return { _tag: "ScheduledEmailInvalid" as const };
    const payload = decoded.success;
    if (!this.hasSubAgent(OsfoAgent, payload.agentId)) {
      return { _tag: "ScheduledEmailUnavailable" as const };
    }
    return (await this.subAgent(OsfoAgent, payload.agentId)).beginScheduledEmail(payload);
  }

  /** Execute or reconcile the exact due Gmail effect through its retained Agent. */
  async executeScheduledEmail(encoded: unknown) {
    const decoded = Schema.decodeUnknownResult(ScheduledEmail.WorkflowPayload)(encoded);
    if (Result.isFailure(decoded)) return { _tag: "ScheduledEmailInvalid" as const };
    const payload = decoded.success;
    if (!this.hasSubAgent(OsfoAgent, payload.agentId)) {
      return { _tag: "ScheduledEmailUnavailable" as const };
    }
    return (await this.subAgent(OsfoAgent, payload.agentId)).executeScheduledEmail(payload);
  }

  /** Reconcile one already-claimed send after its ordinary Agent fence may have closed. */
  async recoverScheduledEmail(encoded: unknown) {
    const decoded = Schema.decodeUnknownResult(ScheduledEmail.WorkflowPayload)(encoded);
    if (Result.isFailure(decoded)) return { _tag: "ScheduledEmailInvalid" as const };
    const payload = decoded.success;
    if (!this.hasSubAgent(OsfoAgent, payload.agentId)) {
      return { _tag: "ScheduledEmailUnavailable" as const };
    }
    return (await this.subAgent(OsfoAgent, payload.agentId)).recoverScheduledEmail(payload);
  }

  /** Route one opaque, PostgreSQL-authorized Scheduled Email follow-up to its exact Agent. */
  async submitScheduledEmailFollowUp(notificationIdentity: string) {
    const decoded = Schema.decodeResult(ScheduledEmailFollowUp.NotificationId)(
      notificationIdentity,
    );
    if (Result.isFailure(decoded)) return { _tag: "ScheduledEmailFollowUpInvalid" as const };
    const notification = await Effect.runPromise(
      ScheduledEmailComposition.followUpEffect(
        { DB: this.env.DB },
        ScheduledEmailFollowUp.Service.pipe(
          Effect.flatMap((followUps) => followUps.inspect(decoded.success)),
          Effect.orDie,
        ),
      ),
    );
    if (notification === null || !this.hasSubAgent(OsfoAgent, notification.agentId)) {
      return { _tag: "ScheduledEmailFollowUpUnavailable" as const };
    }
    return (await this.subAgent(OsfoAgent, notification.agentId)).submitScheduledEmailFollowUp(
      notificationIdentity,
    );
  }

  /** List current personal Skills through one registered User Agent. */
  async inspectPersonalSkills(
    agentId: string,
    actor: { readonly decisionReference: string; readonly userId: string },
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.inspectPersonalSkills({ ...actor, userId: UserId.make(actor.userId) });
  }

  /** Inspect safe Integration Connection state through one registered User Agent. */
  async inspectIntegrationConnections(
    agentId: string,
    actor: { readonly authSessionId: string; readonly userId: string },
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.inspectIntegrationConnections({
      authSessionId: AuthSessionId.make(actor.authSessionId),
      userId: UserId.make(actor.userId),
    });
  }

  /** List one User Agent's exact pending Action presentations. */
  async listActionPresentations(agentId: string, actor: unknown) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.listActionPresentations(actor);
  }

  /** Resolve one User Agent's exact pending Action presentation. */
  async decideActionApproval(agentId: string, input: DecideActionApprovalRequest) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.decideActionApproval(input);
  }

  /** Acquire one provider-hosted Integration Connect Link. */
  async connectIntegrationFromSettings(
    agentId: string,
    input: {
      readonly actor: { readonly authSessionId: string; readonly userId: string };
      readonly callbackUrl: string;
      readonly toolkit: "gmail" | "googlecalendar" | "googledrive";
    },
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.connectIntegrationFromSettings({
      ...input,
      actor: {
        authSessionId: AuthSessionId.make(input.actor.authSessionId),
        userId: UserId.make(input.actor.userId),
      },
    });
  }

  /** Revoke one current Integration Connection. */
  async disconnectIntegrationFromSettings(
    agentId: string,
    input: {
      readonly actor: { readonly authSessionId: string; readonly userId: string };
      readonly toolkit: "gmail" | "googlecalendar" | "googledrive";
    },
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.disconnectIntegrationFromSettings({
      ...input,
      actor: {
        authSessionId: AuthSessionId.make(input.actor.authSessionId),
        userId: UserId.make(input.actor.userId),
      },
    });
  }

  /** Commit one non-destructive personal Skill lifecycle change. */
  async changePersonalSkill(
    agentId: string,
    input: {
      readonly actor: { readonly decisionReference: string; readonly userId: string };
      readonly change: SkillChangeRequest;
    },
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.changePersonalSkill({
      ...input,
      actor: { ...input.actor, userId: UserId.make(input.actor.userId) },
    });
  }

  /** Present the exact current personal Skill lineage for deletion. */
  async presentPersonalSkillDeletion(
    agentId: string,
    input: {
      readonly actor: { readonly decisionReference: string; readonly userId: string };
      readonly reference: string;
    },
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.presentPersonalSkillDeletion({
      ...input,
      actor: { ...input.actor, userId: UserId.make(input.actor.userId) },
    });
  }

  /** Delete one exact personal Skill lineage after Approval. */
  async deletePersonalSkillFromSettings(
    agentId: string,
    input: {
      readonly actor: { readonly decisionReference: string; readonly userId: string };
      readonly reference: string;
      readonly request: SkillDeletionRequest;
    },
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.deletePersonalSkillFromSettings({
      ...input,
      actor: { ...input.actor, userId: UserId.make(input.actor.userId) },
    });
  }

  /** List the authoritative user-owned facet registry. */
  listAgents(): ReadonlyArray<{ readonly className: string; readonly name: string }> {
    return this.listSubAgents(OsfoAgent).map(({ className, name }) => ({ className, name }));
  }

  /** Delete one user-owned facet and its SQLite state. */
  async deleteAgent(agentId: string): Promise<void> {
    await this.ctx.storage.put(qualificationControlledAgentFaultDeletionKey(agentId), true);
    const retained = await this.ctx.storage.list({
      prefix: qualificationControlledAgentFaultPrefix(agentId),
    });
    if (retained.size > 0) await this.ctx.storage.delete([...retained.keys()]);
    await this.deleteSubAgent(OsfoAgent, agentId);
    await this.ctx.storage.delete(qualificationControlledAgentFaultDeletionKey(agentId));
  }

  async #qualificationFaultDeletionFenced(agentId: string): Promise<boolean> {
    return qualificationControlledAgentFaultDeletionFenced({
      hasAgent: () => this.hasSubAgent(OsfoAgent, agentId),
      readDeletionStarted: async () =>
        (await this.ctx.storage.get<boolean>(
          qualificationControlledAgentFaultDeletionKey(agentId),
        )) === true,
    });
  }

  async #qualificationFaultAgent(agentId: string) {
    if (await this.#qualificationFaultDeletionFenced(agentId)) return null;
    try {
      const agent = await this.subAgent(OsfoAgent, agentId);
      return (await this.#qualificationFaultDeletionFenced(agentId)) ? null : agent;
    } catch {
      return null;
    }
  }

  /** Fence new provider appends and wait for already-started provider work. */
  async quiesceAgentAccountDeletion(agentId: string, userId: string): Promise<void> {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return;
    const agent = await this.subAgent(OsfoAgent, agentId);
    await agent.quiesceAccountDeletion(userId);
  }

  async #agentForUser(encodedUserId: string) {
    const userId = await Effect.runPromise(Schema.decodeEffect(UserId)(encodedUserId));
    const route = await Effect.runPromise(
      Effect.scoped(
        AgentDirectory.Service.pipe(
          Effect.flatMap((directory) => directory.resolve(userId)),
          Effect.option,
          Effect.provide(directoryMessengerLayer(this.env)),
        ),
      ),
    );
    if (Option.isNone(route) || !this.hasSubAgent(OsfoAgent, route.value.agentId)) return null;
    return this.subAgent(OsfoAgent, route.value.agentId);
  }

  #resolveMessengerAddress = Effect.fn("OsfoDirectory.resolveMessengerAddress")(
    { self: this },
    function* (this: OsfoDirectory, address: typeof ChannelLinks.ChannelAddress.Type) {
      const channelLinks = yield* ChannelLinks.Service;
      const agentDirectory = yield* AgentDirectory.Service;
      const resolution = yield* channelLinks.resolveConversation(address).pipe(
        Effect.map(Option.some),
        Effect.catchTag("ChannelLinksUnavailable", () => Effect.succeed(Option.none())),
      );
      if (Option.isNone(resolution)) return { _tag: "Unavailable" as const };
      if (resolution.value._tag === "Unlinked") return resolution.value;
      const route = yield* agentDirectory.resolve(resolution.value.link.userId).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          AgentRouteNotFound: () => Effect.succeed(Option.none()),
          DbUnavailable: () => Effect.succeed(Option.none()),
        }),
      );
      if (Option.isNone(route) || !this.hasSubAgent(OsfoAgent, route.value.agentId)) {
        return { _tag: "Unavailable" as const };
      }
      return {
        _tag: "Linked" as const,
        agentId: route.value.agentId,
      } satisfies MessengerAddressResolution;
    },
  );
}

/**
 * Deterministically gate a directory messenger turn before any model or User
 * authority exists. Unlinked direct-message senders never land here: the
 * conversation resolver routes them to their Company Conversation facet.
 */
const replyToDirectoryGate = Effect.fn("OsfoDirectory.replyToMessenger")(function* (
  callback: StreamCallback,
  context: MessengerContext,
) {
  // Think hands messenger turns its serializable event snapshot, which carries
  // the author inside the message rather than at the context top level.
  const authorId = messengerAuthorId(context);
  const message = context.message;
  if (authorId === undefined || message === undefined) {
    yield* streamTextReply(
      callback,
      "channel-address-unreadable",
      "I could not read that message. Please try again.",
    );
    return;
  }
  if (!context.thread.isDirectMessage) {
    yield* streamTextReply(callback, message.id, `${GroupRefusalCopy.en}\n${GroupRefusalCopy.es}`);
    return;
  }
  const channelLinks = yield* ChannelLinks.Service;
  const resolved = yield* channelLinks
    .resolve(channelAddressOf(context.messengerId, authorId))
    .pipe(
      Effect.map(Option.some),
      Effect.catchTag("ChannelLinksUnavailable", () => Effect.succeed(Option.none())),
    );
  const linked = Option.isSome(resolved) && resolved.value !== null;
  if (linked) {
    yield* streamTextReply(
      callback,
      message.id,
      "This channel is linked, but I could not reach your Osfo Agent. Please try again.",
    );
    return;
  }
  yield* streamTextReply(callback, message.id, "Please send that message again.");
});

const qualificationControlledAgentFaultAgentHash = (agentId: string) => {
  return qualificationChecksum({
    agentId,
    kind: "qualification-controlled-agent-fault-agent",
  });
};

const qualificationControlledAgentFaultPrefix = (agentId: string) =>
  `qualification-controlled-agent-fault/${qualificationControlledAgentFaultAgentHash(agentId)}/`;

const qualificationControlledAgentFaultKey = (agentId: string, controllerOperationId: string) =>
  `${qualificationControlledAgentFaultPrefix(agentId)}${encodeURIComponent(controllerOperationId)}`;

const qualificationControlledAgentFaultDeletionKey = (agentId: string) =>
  `qualification-controlled-agent-deleted/${qualificationControlledAgentFaultAgentHash(agentId)}`;

const retainControlledAgentFaultRecord = (
  storage: DurableObjectStorage,
  key: string,
  record: QualificationControlledAgentFaultControllerRecord,
): Promise<QualificationControlledAgentFaultControllerRecord | null> =>
  storage.transaction(async (transaction) => {
    const retained = await transaction.get<QualificationControlledAgentFaultControllerRecord>(key);
    if (retained === undefined) {
      await transaction.put(key, record);
      return record;
    }
    return validQualificationControlledAgentFaultControllerRecord(retained) ? retained : null;
  });

const replaceControlledAgentFaultRecord = (
  storage: DurableObjectStorage,
  key: string,
  expectedChecksum: string,
  record: QualificationControlledAgentFaultControllerRecord,
): Promise<boolean> =>
  storage.transaction(async (transaction) => {
    const retained = await transaction.get<QualificationControlledAgentFaultControllerRecord>(key);
    if (!validQualificationControlledAgentFaultControllerRecord(retained)) return false;
    if (retained.artifactChecksum === record.artifactChecksum) return true;
    if (retained.artifactChecksum !== expectedChecksum) return false;
    await transaction.put(key, record);
    return true;
  });

const directoryMessengerLayer = (env: Env & RuntimeSecrets) => {
  const config = loadConfig(env);
  const base = Layer.merge(Db.layer({ db: env.DB }), BrowserCrypto.layer);
  return Layer.merge(
    ChannelLinks.layerFromConfig(config),
    AgentDirectory.layerWithoutDependencies,
  ).pipe(Layer.provide(base));
};
