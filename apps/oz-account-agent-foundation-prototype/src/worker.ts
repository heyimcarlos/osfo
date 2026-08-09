import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { channelBindings } from "./directory-schema.ts";
import { AccountAgent } from "./account-agent.ts";
import type { MessageAdmission, PrototypeEnv } from "./account-agent.ts";

export { AccountAgent };

type BindingInput = {
  readonly agentId: string;
  readonly channelIdentity: string;
};

const jsonInput = async <A>(request: Request): Promise<A> => (await request.json()) as A;

const notFound = () => Response.json({ error: "not_found" }, { status: 404 });

export default {
  async fetch(request: Request, env: PrototypeEnv): Promise<Response> {
    const url = new URL(request.url);
    const directory = drizzle(env.DIRECTORY);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ profile: "oz-account-agent-foundation-prototype", status: "ready" });
    }

    if (request.method === "POST" && url.pathname === "/bindings") {
      const input = await jsonInput<BindingInput>(request);
      await directory
        .insert(channelBindings)
        .values({ ...input, createdAt: Date.now() })
        .onConflictDoUpdate({
          set: { agentId: input.agentId },
          target: channelBindings.channelIdentity,
        });
      return Response.json({ bound: true, ...input });
    }

    if (request.method === "POST" && url.pathname === "/messages") {
      const input = await jsonInput<MessageAdmission>(request);
      const rows = await directory
        .select({ agentId: channelBindings.agentId })
        .from(channelBindings)
        .where(eq(channelBindings.channelIdentity, input.channelIdentity));
      const agentId = rows[0]?.agentId;
      if (!agentId) {
        return Response.json({ error: "unbound_channel_identity" }, { status: 404 });
      }
      const receipt = await env.ACCOUNT_AGENT.getByName(agentId).acceptMessage(input);
      return Response.json({ agentId, receipt });
    }

    const match = /^\/agents\/([^/]+)\/(state|cancel|schedule)$/.exec(url.pathname);
    if (!match) return notFound();
    const agentId = decodeURIComponent(match[1] ?? "");
    const action = match[2];
    const agent = env.ACCOUNT_AGENT.getByName(agentId);

    if (request.method === "GET" && action === "state") {
      return Response.json(await agent.inspectFoundation());
    }
    if (request.method === "POST" && action === "cancel") {
      const input = await jsonInput<{ readonly submissionId: string }>(request);
      await agent.cancelTurn(input.submissionId);
      return Response.json({ cancelled: true, submissionId: input.submissionId });
    }
    if (request.method === "POST" && action === "schedule") {
      const input = await jsonInput<{
        readonly delaySeconds: number;
        readonly reminderId: string;
        readonly text: string;
      }>(request);
      const schedule = await agent.scheduleReminder(input);
      return Response.json({ schedule });
    }
    return notFound();
  },
} satisfies ExportedHandler<PrototypeEnv>;
