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
import { ChannelPresentationEndpoints } from "../../composition/channel-presentations";
import { Db } from "../../db";
import { makeTelegramChannel } from "../../integrations/telegram";
import { makeWhatsAppChannel } from "../../integrations/whatsapp";
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
import { ThinkMessengerStateAgent } from "./messenger-state";
import { MessengerReset } from "./messenger-reset";
import type { AgentInitializationEncoded } from "./db/store";
import { GroupRefusalCopy } from "./persona";
import { AgentId, UserId } from "../../domain";
import { AccountResetComposition } from "../../composition/account-reset";
import { AuthSessionId } from "../../domain/auth-session";
import { WebFileUpload } from "./web-file-upload";
import { DocumentBuildFileResolution } from "./document-build-file-resolution";
import type { DecideActionApprovalRequest } from "./think-action-approvals";

/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide, eslint/no-underscore-dangle, osfo/no-unknown-parameters -- Think RPC methods receive untrusted payloads and immediately schema-decode them at this messenger composition root. */

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
      [ChannelPresentationEndpoints.telegram.channelId]: makeTelegramChannel({
        apiBaseURL: config.telegram.apiBaseURL,
        conversation,
        secretToken: Redacted.value(config.telegram.webhookSecret),
        token: Redacted.value(config.telegram.botToken),
        userName: config.telegram.botUsername,
      }),
      [ChannelPresentationEndpoints.whatsapp.channelId]: makeWhatsAppChannel({
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

  /** Inspect immediate Gmail outcomes through one registered User Agent. */
  async inspectImmediateGmailSends(
    agentId: string,
    actor: { readonly authSessionId: string; readonly userId: string },
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.inspectImmediateGmailSends({
      authSessionId: AuthSessionId.make(actor.authSessionId),
      userId: UserId.make(actor.userId),
    });
  }

  /** List one User Agent's exact pending Action presentations. */
  async listActionPresentations(
    agentId: string,
    actor: unknown,
    selection?: "immediate-gmail" | "scheduled-email" | "reminder",
  ) {
    if (!this.hasSubAgent(OsfoAgent, agentId)) return null;
    const agent = await this.subAgent(OsfoAgent, agentId);
    return agent.listActionPresentations(actor, selection);
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
    await this.deleteSubAgent(OsfoAgent, agentId);
  }

  /** Prepare one suspended owner's facet for reset; missing facets still require authority. */
  async quiesceAgentAccountReset(encodedAgentId: string, encodedUserId: string): Promise<void> {
    const agentId = await Effect.runPromise(Schema.decodeEffect(AgentId)(encodedAgentId));
    const userId = await Effect.runPromise(Schema.decodeEffect(UserId)(encodedUserId));
    await Effect.runPromise(
      Effect.scoped(
        AccountResetComposition.authorize(agentId, userId).pipe(
          Effect.provide(Db.layer({ db: this.env.DB })),
        ),
      ),
    );
    const phoneNumberId = this.env.WHATSAPP_PHONE_NUMBER_ID;
    const threads = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const links = yield* ChannelLinks.Service;
          const active = yield* links.listActive(userId);
          return yield* Effect.forEach(active, (link) =>
            MessengerReset.threadForAddress(link.address, phoneNumberId),
          );
        }).pipe(Effect.provide(directoryMessengerLayer(this.env))),
      ),
    );
    if (this.hasSubAgent(OsfoAgent, agentId)) {
      const agent = await this.subAgent(OsfoAgent, agentId);
      await agent.quiesceAccountReset(userId);
    }
    const fibers = await Effect.runPromise(MessengerReset.fibers(this.ctx.storage.sql, threads));
    for (const fiber of fibers) {
      if (fiber.status === "pending" || fiber.status === "running") {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Apply cancellation before inspecting retained execution.
        await this.cancelFiber(fiber.fiber_id, "Account reset");
      }
    }
    await Effect.runPromise(MessengerReset.requireSettled(this.ctx.storage.sql, threads));
    for (const thread of threads) {
      for (const shard of MessengerReset.shardNames(thread)) {
        if (this.hasSubAgent(ThinkMessengerStateAgent, shard)) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Check the media lock shard before clearing its buffers and thread history.
          const state = await this.subAgent(ThinkMessengerStateAgent, shard);
          // oxlint-disable-next-line eslint/no-await-in-loop -- Finish each shard's cleanup before root snapshots are deleted.
          const result = await state.resetAccountThread(thread);
          if (result === "busy") {
            throw new Error("Messenger queue is active; retry the suspended account reset");
          }
        }
      }
    }
    await Effect.runPromise(MessengerReset.eraseFibers(this.ctx.storage, threads));
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

const directoryMessengerLayer = (env: Env & RuntimeSecrets) => {
  const config = loadConfig(env);
  const base = Layer.merge(Db.layer({ db: env.DB }), BrowserCrypto.layer);
  return Layer.merge(
    ChannelLinks.layerFromConfig(config),
    AgentDirectory.layerWithoutDependencies,
  ).pipe(Layer.provide(base));
};
