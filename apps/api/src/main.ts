import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { OsfoApiLive } from "@osfo/api/server";
import { makeMessageAdmissionLayer } from "@osfo/db";
import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { createServer } from "node:http";

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

const port = Number(process.env.OSFO_API_PORT ?? "3000");
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
  throw new Error("OSFO_API_PORT must be a valid TCP port");
}

const MessageAdmissionLive = makeMessageAdmissionLayer({
  databaseUrl: requireEnvironment("OSFO_DATABASE_URL"),
  executionProfileRef: requireEnvironment("OSFO_EXECUTION_PROFILE_REF"),
  globalNonTerminalLimit: positiveIntegerEnvironment("OSFO_GLOBAL_NON_TERMINAL_LIMIT"),
  principalNonTerminalLimit: positiveIntegerEnvironment("OSFO_PRINCIPAL_NON_TERMINAL_LIMIT"),
});

const ServerLive = HttpRouter.serve(OsfoApiLive).pipe(
  Layer.provide(MessageAdmissionLive),
  Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port })),
);

NodeRuntime.runMain(Layer.launch(ServerLive));
