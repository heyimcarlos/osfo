import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));

export interface ApiProcessOptions {
  readonly databaseUrl: string;
  readonly executionProfileRef?: string;
  readonly globalNonTerminalLimit?: number;
  readonly principalNonTerminalLimit?: number;
}

export const startApiProcess = async (options: ApiProcessOptions) => {
  const child = spawn(process.execPath, ["dist/main.js"], {
    cwd: packageDirectory,
    env: {
      ...process.env,
      OSFO_API_PORT: "0",
      OSFO_DATABASE_URL: options.databaseUrl,
      OSFO_EXECUTION_PROFILE_REF: options.executionProfileRef ?? "oz.process-test.v1",
      OSFO_GLOBAL_NON_TERMINAL_LIMIT: String(options.globalNonTerminalLimit ?? 8),
      OSFO_PRINCIPAL_NON_TERMINAL_LIMIT: String(options.principalNonTerminalLimit ?? 4),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const port = await new Promise<number>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`process did not listen: ${output}`)), 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      const match = output.match(/Listening on http:\/\/127\.0\.0\.1:(\d+)/u);
      if (match?.[1] !== undefined) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`process exited before listening (${String(code)}): ${output}`));
    });
  });

  return {
    port,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    },
  };
};
