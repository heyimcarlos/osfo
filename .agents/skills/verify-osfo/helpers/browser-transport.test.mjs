/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/global-fetch -- This isolated process test exercises actual Wrangler startup and HTTP redirect behavior through Node process and network boundaries. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scratch = await mkdtemp(resolve(root, "node_modules/.browser-transport-"));
const token = "canary-browser-secret-must-never-appear-in-logs-0123456789";
const received = [];
const host = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    received.push({ path: request.url, token: request.headers.authorization, body });
    if (request.url === "/redirect/inventory" || request.url === "/browser") {
      response.writeHead(307, { location: `http://127.0.0.1:${host.address().port}/forbidden` });
    } else response.writeHead(401);
    response.end();
  });
});
host.listen(0, "127.0.0.1");
await once(host, "listening");
const hostOrigin = `http://127.0.0.1:${host.address().port}`;
let child;
let logs = "";
try {
  const config = resolve(scratch, "wrangler.json");
  const binding = resolve(scratch, "binding.json");
  await writeFile(config, JSON.stringify({ name: "osfo-verification-transport-test", main: "worker.ts", compatibility_date: "2026-08-12", vars: { OSFO_STAGE: "test" } }));
  await writeFile(binding, JSON.stringify({ BROWSER_HOST_ENDPOINT: "http://127.0.0.1:39270/inventory", BROWSER_HOST_OWNER_USER_ID: "owner", BROWSER_HOST_SESSION_ID: "extension", BROWSER_HOST_TOKEN: token, BROWSER_HOST_ALLOWED_ORIGINS: '["http://127.0.0.1:39271"]' }));
  const bind = spawn("bun", [resolve(root, ".agents/skills/verify-osfo/helpers/browser-binding.mjs"), config, binding, "owner"], { stdio: "pipe" });
  assert.equal((await once(bind, "exit"))[0], 0);
  assert.equal((await readFile(config, "utf8")).includes(token), false);
  await writeFile(resolve(scratch, "worker.ts"), `
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Browser } from ${JSON.stringify(resolve(root, "apps/worker/src/services/browser-host.ts"))};
export default { async fetch(request, env) {
 const path = new URL(request.url).pathname;
 if(path === '/ready') return new Response('ready');
 const binding = { allowedOrigins: [], endpoint: ${JSON.stringify(hostOrigin)} + (path === '/direct' ? '/inventory' : '/redirect/inventory'), hostSessionId:'extension',ownerUserId:'owner',token:Redacted.make(env.BROWSER_HOST_TOKEN) };
 const identity = {ownerUserId:'owner',hostSessionId:'extension',operationId:'op',turnId:'turn'};
 const effect = path === '/execute' ? Browser.execute({...identity, taskId:'task', command:{_tag:'Outcome',operationId:'prior'}}, binding) : Browser.dispatch({...identity,operation:'inventory'},binding);
 const result = await Effect.runPromise(effect.pipe(Effect.provide(FetchHttpClient.layer),Effect.match({onFailure:error=>error._tag,onSuccess:()=> 'UnexpectedSuccess'})));
 return Response.json(result);
}};`);
  child = spawn(resolve(root, "apps/worker/node_modules/.bin/wrangler"), ["dev", "--config", config, "--ip", "127.0.0.1", "--port", "0", "--inspector-port", "0", "--show-interactive-dev-session", "false"], { env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });
  let origin;
  for (let attempt = 0; attempt < 150; attempt++) {
    origin = logs.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (origin || child.exitCode !== null) break;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Readiness probes must wait for the child process to emit its listening address.
    await setTimeout(100);
  }
  assert.ok(origin, "Isolated Wrangler failed to become ready");
  for (const path of ["/direct", "/redirect", "/execute"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Ordered requests make the redirect trap evidence unambiguous.
    assert.equal(await (await fetch(origin + path)).json(), "BrowserUnavailable");
  }
  assert.deepEqual(received.map(request => request.path), ["/inventory", "/redirect/inventory", "/browser"]);
  assert.ok(received.every(request => request.token === `Bearer ${token}` && request.body.includes('"operationId":"op"')));
  assert.equal(logs.includes(token.slice(0, 20)), false, "Wrangler must redact secret prefix");
  assert.ok(logs.includes("BROWSER_HOST_TOKEN"), "Startup must list the secret binding");
  process.stdout.write("Actual Workerd reached host, rejected redirects without forwarding, and Wrangler redacted the secret.\n");
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  host.closeAllConnections();
  const closed = once(host, "close");
  host.close();
  await closed;
  await rm(scratch, { recursive: true, force: true });
}
