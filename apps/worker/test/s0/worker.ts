/* oxlint-disable effecttsgo/global-fetch, effecttsgo/async-function -- throwaway S0 spike exercising raw runtime fetch and stubs; product code uses Effect HttpClient */
import { DurableObject } from "cloudflare:workers";
import postgres from "postgres";

/** Spike env extends the generated env with the probe binding and injected marker. */
interface ProbeEnv extends Cloudflare.Env {
  readonly PROBE: DurableObjectNamespace;
  readonly SPIKE_MARKER: string;
}

export class Probe extends DurableObject<ProbeEnv> {
  dbIdentity() {
    return {
      connectionString: this.env.DB.connectionString,
      marker: this.env.SPIKE_MARKER,
    };
  }

  async outbound(): Promise<{ status: number; body: string }> {
    const response = await fetch("https://do-provider.example/v1/turn");
    return { status: response.status, body: await response.text() };
  }

  async stream(): Promise<{ status: number; contentType: string; body: string }> {
    const response = await fetch("https://llm-provider.example/v1/chat/completions", {
      method: "POST",
      headers: { accept: "text/event-stream" },
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "none",
      body: await response.text(),
    };
  }

  async query(): Promise<{ ok: boolean; detail: string }> {
    return runQuery(this.env.DB.connectionString);
  }

  override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/identity") return Response.json(this.dbIdentity());
    if (pathname === "/outbound") return Response.json(await this.outbound());
    if (pathname === "/stream") return Response.json(await this.stream());
    if (pathname === "/query") return Response.json(await this.query());
    return new Response("not found", { status: 404 });
  }
}

export async function runQuery(
  connectionString?: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!connectionString) return { ok: false, detail: "no connectionString" };
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    fetch_types: false,
    idle_timeout: 1,
    connect_timeout: 5,
  });
  try {
    const rows = await sql`select 1 as one`;
    return { ok: rows[0]?.one === 1, detail: "select 1 via postgres.js" };
  } catch (error) {
    return { ok: false, detail: `query failed: ${String(error)}` };
  }
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    const probe = env.PROBE.get(env.PROBE.idFromName("spike"));
    switch (url.pathname) {
      case "/env":
        return Response.json({
          marker: env.SPIKE_MARKER,
          db: env.DB.connectionString,
        });
      case "/query":
        return Response.json(await runQuery(env.DB.connectionString));
      case "/do/env": {
        const response = await probe.fetch(new Request("https://probe.internal/identity"));
        return new Response(response.body, { status: response.status });
      }
      case "/do/query": {
        const response = await probe.fetch(new Request("https://probe.internal/query"));
        return new Response(response.body, { status: response.status });
      }
      case "/do/outbound": {
        const response = await probe.fetch(new Request("https://probe.internal/outbound"));
        return new Response(response.body, { status: response.status });
      }
      case "/do/stream": {
        const response = await probe.fetch(new Request("https://probe.internal/stream"));
        return new Response(response.body, { status: response.status });
      }
      case "/outbound":
      case "/outbound/denied": {
        const host = url.pathname.endsWith("/denied") ? "denied.example" : "main-provider.example";
        const providerResponse = await fetch(`https://${host}/v1/x`);
        return new Response(await providerResponse.text(), { status: providerResponse.status });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  },
} satisfies ExportedHandler<ProbeEnv>;
