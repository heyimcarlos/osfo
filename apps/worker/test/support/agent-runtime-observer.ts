/* oxlint-disable effecttsgo/async-function, eslint/no-underscore-dangle, osfo/no-unknown-returns -- This local verification Worker adapts Cloudflare's opaque Workflow status and production Directory RPC promises without exposing private bodies. */

import { OSFO_DIRECTORY_NAME } from "../../src/agents/osfo/identity";
import { UserId } from "../../src/domain";
import { ContentId } from "../../src/domain/client-content";
import {
  attemptKeyFor,
  contentKeyFor,
  ownerKeyFor,
} from "../../src/integrations/cloudflare/document-storage-keys";
import { OsfoAgent } from "../../src/worker";
import { getSubAgentByName } from "agents";

export {
  ExecutionUnitWorkflow,
  OsfoDirectory,
  DocumentBuildTimerWorkflow,
  DocumentBuildWorkflow,
  ResearchReportTimerWorkflow,
  ResearchReportWorkflow,
  Sandbox,
  ScheduledEmailWorkflow,
  ThinkMessengerStateAgent,
} from "../../src/worker";
export { OsfoAgent };

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
    return Response.json(
      includeConversation
        ? {
            ...evidence,
            conversation: await conversationEvidence(directory, agentId, inspection),
          }
        : evidence,
    );
  },
} satisfies ExportedHandler<ObserverBindings>;

export default worker;
