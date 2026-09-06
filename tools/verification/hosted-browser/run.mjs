/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/global-fetch, effecttsgo/global-date -- Standalone Node verification launcher owns filesystem, HTTP, and evidence timestamp boundaries. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = process.argv[2];
const endpoint = new URL(process.argv[3] ?? "http://127.0.0.1:8798/qualify");
if (
  !directory ||
  !directory.startsWith("/tmp/") ||
  !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
  endpoint.pathname !== "/qualify"
) {
  throw new Error("Usage: node run.mjs /tmp/qualification-directory http://127.0.0.1:8798/qualify");
}
const environment = await readFile(resolve(directory, ".dev.vars"), "utf8");
const token = environment.match(/^QUALIFICATION_TOKEN=([a-f0-9]{64})$/m)?.[1];
if (!token) throw new Error("Qualification token is missing");
const unauthorized = await fetch(endpoint, { method: "POST", redirect: "error" });
if (unauthorized.status !== 401)
  throw new Error("Qualification endpoint did not reject unauthenticated access");
const response = await fetch(endpoint, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  redirect: "error",
  signal: AbortSignal.timeout(180000),
});
const result = await response.json();
await writeFile(
  resolve(directory, `evidence-${Date.now()}.json`),
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      unauthorizedStatus: unauthorized.status,
      providerStatus: response.status,
      result,
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
if (!response.ok || result?.passed !== true) process.exitCode = 1;
