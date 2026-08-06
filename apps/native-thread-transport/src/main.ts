import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { makeMessageAdmissionLayer } from "@osfo/db";
import { MessageAdmission, makeNativeThreadRequestHandler } from "@osfo/native-thread-transport";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ManagedRuntime from "effect/ManagedRuntime";

const requireEnvironment = (name: string) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const positiveIntegerEnvironment = (name: string) => {
  const value = Number(requireEnvironment(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

const portEnvironment = process.env.OSFO_NATIVE_THREAD_TRANSPORT_PORT ?? "3000";
const port = Number(portEnvironment);
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
  throw new Error("OSFO_NATIVE_THREAD_TRANSPORT_PORT must be a valid TCP port");
}

const host = "127.0.0.1";
const admissionLayer = makeMessageAdmissionLayer({
  databaseUrl: requireEnvironment("OSFO_DATABASE_URL"),
  executionProfileRef: requireEnvironment("OSFO_EXECUTION_PROFILE_REF"),
  globalNonTerminalLimit: positiveIntegerEnvironment("OSFO_GLOBAL_NON_TERMINAL_LIMIT"),
  principalNonTerminalLimit: positiveIntegerEnvironment("OSFO_PRINCIPAL_NON_TERMINAL_LIMIT"),
});
const runtime = ManagedRuntime.make(admissionLayer);
const handleRequest = makeNativeThreadRequestHandler((command) =>
  Effect.promise(() =>
    runtime.runPromiseExit(MessageAdmission.use((admission) => admission.accept(command))),
  ).pipe(
    Effect.flatMap(
      Exit.match({
        onFailure: Effect.failCause,
        onSuccess: Effect.succeed,
      }),
    ),
  ),
);

const readBody = async (request: IncomingMessage, maximumBytes: number) => {
  const chunks: Array<Buffer> = [];
  let totalBytes = 0;
  let tooLarge = false;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    totalBytes += chunk.length;
    if (totalBytes > maximumBytes) {
      tooLarge = true;
    } else if (!tooLarge) {
      chunks.push(chunk);
    }
  }
  return tooLarge ? undefined : Buffer.concat(chunks);
};

const requestHeaders = (request: IncomingMessage) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
};

const writeWebResponse = async (webResponse: Response, response: ServerResponse) => {
  response.statusCode = webResponse.status;
  for (const [name, value] of webResponse.headers) {
    response.setHeader(name, value);
  }
  response.end(Buffer.from(await webResponse.arrayBuffer()));
};

const server = createServer(async (request, response) => {
  try {
    const body = await readBody(request, 65_536);
    if (body === undefined) {
      await writeWebResponse(
        Response.json(
          {
            protocolVersion: 1,
            type: "malformed_request",
            title: "Malformed request",
            retryable: false,
          },
          { status: 413 },
        ),
        response,
      );
      return;
    }

    const method = request.method ?? "GET";
    const init: RequestInit =
      method === "GET" || method === "HEAD"
        ? { method, headers: requestHeaders(request) }
        : { method, headers: requestHeaders(request), body };
    const webRequest = new Request(`http://${host}:${String(port)}${request.url ?? "/"}`, init);
    const webResponse = await Effect.runPromise(handleRequest(webRequest));
    await writeWebResponse(webResponse, response);
  } catch {
    await writeWebResponse(
      Response.json(
        {
          protocolVersion: 1,
          type: "transport_unavailable",
          title: "Transport unavailable",
          retryable: true,
        },
        { status: 503 },
      ),
      response,
    );
  }
});

server.listen(port, host, () => {
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Native Thread Transport did not bind a TCP address");
  }
  process.stdout.write(
    `Native Thread Transport listening on http://${host}:${String(address.port)}\n`,
  );
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    void runtime.dispose().finally(() => {
      process.exitCode = 0;
    });
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
