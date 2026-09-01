/* oxlint-disable effecttsgo/async-function, eslint/no-underscore-dangle, osfo/no-unknown-returns -- This local verification Worker adapts Cloudflare's opaque Workflow status and production Directory RPC promises without exposing private bodies. */

import { OSFO_DIRECTORY_NAME } from "../../src/agents/osfo/identity";
import { ImmediateGmailSend } from "../../src/agents/osfo/immediate-gmail-send";
import { ActionPresentation } from "../../src/agents/osfo/think-action-approvals";
import { UserId } from "../../src/domain";
import { ContentId } from "../../src/domain/client-content";
import {
  attemptKeyFor,
  contentKeyFor,
  ownerKeyFor,
} from "../../src/integrations/cloudflare/document-storage-keys";
// oxlint-disable-next-line osfo/no-import-alias -- The verification script must export a concrete class named OsfoAgent for the Agents runtime resolver.
import { OsfoAgent as SourceOsfoAgent } from "../../src/worker";
import { Schema } from "effect";
import { getSubAgentByName } from "agents";

export {
  OsfoDirectory,
  DocumentBuildTimerWorkflow,
  DocumentBuildWorkflow,
  ResearchReportTimerWorkflow,
  ResearchReportWorkflow,
  Sandbox,
  ScheduledEmailWorkflow,
  ThinkMessengerStateAgent,
} from "../../src/worker";

const AppliedIntegrationAction = Schema.TaggedStruct("Applied", {
  providerRequestId: Schema.String,
  result: Schema.Struct({
    evidence: Schema.Struct({
      providerLogId: Schema.String,
      providerResourceId: Schema.String,
    }),
    operation: Schema.Literal("GMAIL_SEND_EMAIL"),
    toolkit: Schema.Literal("gmail"),
  }),
});

const IntegrationSession = Schema.Struct({
  providerSessionId: Schema.String,
  userId: UserId,
  version: Schema.String,
});

const ImmediateGmailResultVerificationRequest = Schema.Struct({
  actionId: Schema.String,
  presentationId: Schema.String,
  userId: UserId,
});

type ImmediateGmailResultVerificationRequest = typeof ImmediateGmailResultVerificationRequest.Type;

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Add read-only, privacy-safe storage evidence only in the local verification Worker. */
export class OsfoAgent extends SourceOsfoAgent {
  /** The observer reads an already-started Agent and must not start production background work. */
  override async onStart(): Promise<void> {}

  async inspectImmediateGmailApprovalVerificationState(userId: UserId) {
    const [presentationValues, bindingValues] = await Promise.all([
      this.ctx.storage.list({ prefix: "osfo:action-presentation:" }),
      this.ctx.storage.list({ prefix: "osfo:immediate-gmail-send:approval:" }),
    ]);
    const presentations = [...presentationValues.values()].flatMap((value) => {
      const presentation = Schema.decodeUnknownOption(ActionPresentation)(value, {
        onExcessProperty: "error",
      });
      return presentation._tag === "Some" &&
        presentation.value.actionDefinitionVersion === "osfo-gmail-send-v1" &&
        presentation.value.operation === "integration.effect"
        ? [presentation.value]
        : [];
    });
    const approvalBindings = [...bindingValues.values()].flatMap((value) => {
      const binding = Schema.decodeUnknownOption(ImmediateGmailSend.ApprovalConnectionBinding)(
        value,
        { onExcessProperty: "error" },
      );
      return binding._tag === "Some" && binding.value.userId === userId ? [binding.value] : [];
    });
    const matches = approvalBindings.flatMap((binding) => {
      const matchingPresentations = presentations.filter(
        (presentation) =>
          presentation.actionId === binding.actionId &&
          presentation.presentationId === binding.presentationId,
      );
      return matchingPresentations.map((presentation) => ({
        approvalBinding: binding,
        presentation,
      }));
    });
    const [match] = matches;
    if (matches.length !== 1 || match === undefined) {
      return {
        _tag: "ImmediateGmailApprovalEvidenceUnavailable" as const,
        approvalBindingCount: approvalBindings.length,
        presentationCount: presentations.length,
        reason: matches.length === 0 ? ("missing" as const) : ("ambiguous" as const),
      };
    }
    return {
      _tag: "ImmediateGmailApprovalEvidenceFound" as const,
      ...match,
    };
  }

  async inspectImmediateGmailResultVerificationState(
    input: ImmediateGmailResultVerificationRequest,
  ) {
    const parsed = Schema.decodeSync(ImmediateGmailResultVerificationRequest)(input, {
      onExcessProperty: "error",
    });
    const [openValue, terminalValues, integrationValue, sessionValue] = await Promise.all([
      this.ctx.storage.get(`osfo:immediate-gmail-send:open:${parsed.actionId}`),
      this.ctx.storage.list({ prefix: "osfo:immediate-gmail-send:terminal:" }),
      this.ctx.storage.get(`integration:action:${parsed.actionId}`),
      this.ctx.storage.get(`integration:session:${parsed.userId}`),
    ]);
    const openContext = Schema.decodeUnknownOption(ImmediateGmailSend.Context)(openValue, {
      onExcessProperty: "error",
    });
    const terminals = [...terminalValues.values()].flatMap((value) => {
      const terminal = Schema.decodeUnknownOption(ImmediateGmailSend.TerminalStatus)(value, {
        onExcessProperty: "error",
      });
      return terminal._tag === "Some" && terminal.value.actionId === parsed.actionId
        ? [terminal.value]
        : [];
    });
    const integrationAction = Schema.decodeUnknownOption(AppliedIntegrationAction)(
      integrationValue,
      { onExcessProperty: "preserve" },
    );
    const integrationSession = Schema.decodeUnknownOption(IntegrationSession)(sessionValue, {
      onExcessProperty: "error",
    });
    return {
      integrationAction: integrationAction._tag === "Some" ? integrationAction.value : null,
      integrationSessionHash:
        integrationSession._tag === "Some"
          ? await sha256(integrationSession.value.providerSessionId)
          : null,
      openContextExists: openContext._tag === "Some",
      terminals,
    };
  }
}

interface AgentInspection {
  readonly agentId: string;
  readonly currentSessionId: string;
  readonly routeId: string;
}

interface ReminderVerificationState {
  readonly activeScheduleBindingCount: number;
  readonly agentScheduleCount: number;
  readonly occurrenceCount: number;
  readonly occurrences: ReadonlyArray<{
    readonly callbackCapabilityRevokedAt: string | null;
    readonly committedAt: string | null;
    readonly exposedAt: string | null;
    readonly nominalDueAt: string;
    readonly sourceIdentity: string;
    readonly sourceRevokedAt: string | null;
    readonly thinkPresentedAt: string | null;
    readonly thinkSubmissionId: string | null;
  }>;
  readonly reminderCount: number;
}

interface DirectoryObserver {
  readonly inspectAgent: (agentId: string) => Promise<AgentInspection | null>;
  readonly listAgents: () => Promise<
    ReadonlyArray<{ readonly className: string; readonly name: string }>
  >;
  readonly pendingReminderWakeUpSources: (
    userId: string,
  ) => Promise<ReadonlyArray<{ readonly committedAt: string; readonly sourceIdentity: string }>>;
  readonly inspectReminderVerificationState: (
    userId: string,
  ) => Promise<ReminderVerificationState | null>;
  readonly inspectDocumentBuildSourceSnapshot: (input: {
    readonly agentId: string;
    readonly fileId: string;
    readonly userId: string;
  }) => Promise<
    | {
        readonly _tag: "Found";
        readonly byteLength: bigint;
        readonly fileId: string;
        readonly mediaType: string;
        readonly sha256: string;
        readonly state: "ready";
        readonly userId: string;
      }
    | { readonly _tag: "Unavailable" }
  >;
}

interface ObserverBindings {
  readonly ARTIFACTS: R2Bucket;
  readonly DOCUMENT_BUILD_TIMER_WORKFLOW: {
    readonly get: (id: string) => Promise<{ readonly status: () => Promise<unknown> }>;
  };
  readonly DOCUMENT_BUILD_WORKFLOW: {
    readonly get: (id: string) => Promise<{ readonly status: () => Promise<unknown> }>;
  };
  readonly OSFO_DIRECTORY: {
    readonly getByName: (name: string) => DirectoryObserver;
  };
  readonly FILES: R2Bucket;
  readonly SCHEDULED_EMAIL_WORKFLOW: {
    readonly get: (id: string) => Promise<{ readonly status: () => Promise<unknown> }>;
  };
}

const r2Evidence = async (bucket: R2Bucket, key: string) => {
  const object = await bucket.head(key);
  return object === null
    ? null
    : {
        customMetadata: object.customMetadata ?? {},
        checksums: object.checksums.toJSON(),
        httpMetadata: object.httpMetadata ?? {},
        key,
        size: object.size,
      };
};

const conversationEvidence = async (
  directory: DirectoryObserver,
  agentId: string,
  directoryInspection: AgentInspection | null,
) => {
  if (directoryInspection?.agentId !== agentId) {
    return { _tag: "Unavailable", operation: "inspectAgent" } as const;
  }
  const agent = await getSubAgentByName(directory, OsfoAgent, agentId);
  const inspection = await agent.inspect();
  if (inspection._tag !== "AgentFound") {
    return { _tag: "Unavailable", operation: "inspect", resultTag: inspection._tag } as const;
  }
  const route = await agent.readRoute(inspection.routeId);
  if (route._tag !== "ConversationRouteFound") {
    return { _tag: "Unavailable", operation: "readRoute", resultTag: route._tag } as const;
  }
  const [currentSession, historicalSessions] = await Promise.all([
    agent.readSession(route.currentSessionId),
    Promise.all(route.historicalSessionIds.map((sessionId) => agent.readSession(sessionId))),
  ]);
  return {
    _tag: "ConversationEvidence",
    agent: inspection,
    currentSession,
    historicalSessions,
    route,
  } as const;
};

const immediateGmailEvidence = async (input: {
  readonly actionId: string | null;
  readonly agentId: string;
  readonly directory: DirectoryObserver;
  readonly directoryInspection: AgentInspection | null;
  readonly phase: "action" | "result";
  readonly presentationId: string | null;
  readonly userId: string;
}) => {
  if (input.directoryInspection?.agentId !== input.agentId) {
    return { _tag: "Unavailable", operation: "inspectAgent" } as const;
  }
  const agent = await getSubAgentByName(input.directory, OsfoAgent, input.agentId);
  if (input.phase === "action") {
    return agent.inspectImmediateGmailApprovalVerificationState(UserId.make(input.userId));
  }
  if (input.actionId === null || input.presentationId === null) {
    return { _tag: "Unavailable", operation: "missingImmediateGmailIdentity" } as const;
  }
  const storage = await agent.inspectImmediateGmailResultVerificationState({
    actionId: input.actionId,
    presentationId: input.presentationId,
    userId: UserId.make(input.userId),
  });
  const statuses = storage.terminals.map(({ actionId, presentationId, status }) => ({
    actionId,
    presentationId,
    status,
  }));
  return { _tag: "ImmediateGmailResultEvidence", statuses, storage } as const;
};

/** Observe an exact Agent through the production-owned Directory RPC contract. */
const worker = {
  async fetch(request: Request, env: ObserverBindings): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ status: "ready" });
    if (request.method !== "GET" || url.pathname !== "/agent") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const agentId = url.searchParams.get("agentId");
    if (agentId === null || !/^[A-Za-z0-9_-]+$/u.test(agentId)) {
      return Response.json({ error: "Invalid Agent ID" }, { status: 400 });
    }
    const directory = env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
    const conversation = url.searchParams.get("conversation");
    if (conversation !== null && conversation !== "1") {
      return Response.json({ error: "Invalid conversation flag" }, { status: 400 });
    }
    const includeConversation = conversation === "1";
    const userId = url.searchParams.get("userId");
    if (userId !== null && !/^[A-Za-z0-9_-]+$/u.test(userId)) {
      return Response.json({ error: "Invalid User ID" }, { status: 400 });
    }
    const fileId = url.searchParams.get("fileId");
    const mainInstanceId = url.searchParams.get("mainInstanceId");
    const timerInstanceId = url.searchParams.get("timerInstanceId");
    const artifactId = url.searchParams.get("artifactId");
    const scheduledEmailInstanceId = url.searchParams.get("scheduledEmailInstanceId");
    const immediateGmailPhase = url.searchParams.get("immediateGmailPhase");
    if (
      immediateGmailPhase !== null &&
      immediateGmailPhase !== "action" &&
      immediateGmailPhase !== "result"
    ) {
      return Response.json({ error: "Invalid Immediate Gmail phase" }, { status: 400 });
    }
    const immediateGmailActionId = url.searchParams.get("immediateGmailActionId");
    const immediateGmailPresentationId = url.searchParams.get("immediateGmailPresentationId");
    if (immediateGmailPhase !== null && userId === null) {
      return Response.json({ error: "Immediate Gmail User is missing" }, { status: 400 });
    }
    const sourceKey =
      userId === null || fileId === null
        ? null
        : `users/${encodeURIComponent(userId)}/files/${encodeURIComponent(fileId)}/source`;
    const contentId = artifactId === null ? null : ContentId.make(artifactId);
    const [
      inspection,
      agents,
      reminderSources,
      reminderVerification,
      documentBuildSource,
      documentBuildMain,
      documentBuildTimer,
      documentContent,
      documentAttempt,
      documentOwner,
      documentSourceObject,
      scheduledEmailWorkflow,
    ] = await Promise.all([
      directory.inspectAgent(agentId),
      directory.listAgents(),
      userId === null ? Promise.resolve([]) : directory.pendingReminderWakeUpSources(userId),
      userId === null ? Promise.resolve(null) : directory.inspectReminderVerificationState(userId),
      userId === null || fileId === null
        ? Promise.resolve(null)
        : directory.inspectDocumentBuildSourceSnapshot({ agentId, fileId, userId }),
      mainInstanceId === null
        ? Promise.resolve(null)
        : env.DOCUMENT_BUILD_WORKFLOW.get(mainInstanceId).then(
            (instance) => instance.status(),
            () => null,
          ),
      timerInstanceId === null
        ? Promise.resolve(null)
        : env.DOCUMENT_BUILD_TIMER_WORKFLOW.get(timerInstanceId).then(
            (instance) => instance.status(),
            () => null,
          ),
      contentId === null
        ? Promise.resolve(null)
        : r2Evidence(env.ARTIFACTS, contentKeyFor(contentId)),
      contentId === null
        ? Promise.resolve(null)
        : r2Evidence(env.ARTIFACTS, attemptKeyFor(contentId)),
      contentId === null || userId === null
        ? Promise.resolve(null)
        : r2Evidence(env.ARTIFACTS, ownerKeyFor(UserId.make(userId), contentId)),
      sourceKey === null ? Promise.resolve(null) : r2Evidence(env.FILES, sourceKey),
      scheduledEmailInstanceId === null
        ? Promise.resolve(null)
        : env.SCHEDULED_EMAIL_WORKFLOW.get(scheduledEmailInstanceId).then(
            (instance) => instance.status(),
            () => null,
          ),
    ]);
    const evidence = {
      agentId,
      inspectable: inspection?.agentId === agentId,
      registered: agents.some(
        ({ className, name }) => className === "OsfoAgent" && name === agentId,
      ),
      reminderSources,
      reminderVerification,
      documentBuildSource:
        documentBuildSource?._tag === "Found"
          ? { ...documentBuildSource, byteLength: documentBuildSource.byteLength.toString() }
          : documentBuildSource,
      documentBuildMain,
      documentBuildTimer,
      documentContent,
      documentAttempt,
      documentOwner,
      documentSourceObject,
      scheduledEmailWorkflow,
    };
    const immediateGmail =
      immediateGmailPhase === null || userId === null
        ? null
        : await immediateGmailEvidence({
            actionId: immediateGmailActionId,
            agentId,
            directory,
            directoryInspection: inspection,
            phase: immediateGmailPhase,
            presentationId: immediateGmailPresentationId,
            userId,
          });
    return Response.json(
      includeConversation
        ? {
            ...evidence,
            conversation: await conversationEvidence(directory, agentId, inspection),
            immediateGmail,
          }
        : { ...evidence, immediateGmail },
    );
  },
} satisfies ExportedHandler<ObserverBindings>;

export default worker;
