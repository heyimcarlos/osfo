/* oxlint-disable effecttsgo/async-function -- This local verification Worker adapts production Directory RPC promises. */

import { OSFO_DIRECTORY_NAME } from "../../src/agents/osfo/identity";

export {
  ExecutionUnitWorkflow,
  OsfoAgent,
  OsfoDirectory,
  Sandbox,
  ThinkMessengerStateAgent,
} from "../../src/worker";

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
}

interface ObserverBindings {
  readonly OSFO_DIRECTORY: {
    readonly getByName: (name: string) => DirectoryObserver;
  };
}

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
    const userId = url.searchParams.get("userId");
    if (userId !== null && !/^[A-Za-z0-9_-]+$/u.test(userId)) {
      return Response.json({ error: "Invalid User ID" }, { status: 400 });
    }
    const [inspection, agents, reminderSources, reminderVerification] = await Promise.all([
      directory.inspectAgent(agentId),
      directory.listAgents(),
      userId === null ? Promise.resolve([]) : directory.pendingReminderWakeUpSources(userId),
      userId === null ? Promise.resolve(null) : directory.inspectReminderVerificationState(userId),
    ]);
    return Response.json({
      agentId,
      inspectable: inspection?.agentId === agentId,
      registered: agents.some(
        ({ className, name }) => className === "OsfoAgent" && name === agentId,
      ),
      reminderSources,
      reminderVerification,
    });
  },
} satisfies ExportedHandler<ObserverBindings>;

export default worker;
