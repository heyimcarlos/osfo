// oxlint-disable-next-line effecttsgo/node-builtin-import -- This Node-only parity audit reads checked-in deployment configuration.
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

const sandboxHosts = [
  {
    name: "Alchemy Worker",
    source: readFileSync(new URL("../../../infra/cloudflare/Worker.ts", import.meta.url), "utf8"),
    transport: 'SANDBOX_TRANSPORT: "rpc"',
  },
  {
    name: "Wrangler Worker",
    source: readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    transport: '"SANDBOX_TRANSPORT": "rpc"',
  },
  {
    name: "Worker journey",
    source: readFileSync(new URL("../test/wrangler.journeys.jsonc", import.meta.url), "utf8"),
    transport: '"SANDBOX_TRANSPORT": "rpc"',
  },
] as const;

it.each(sandboxHosts)(
  "keeps RPC transport enabled for the $name Sandbox",
  ({ source, transport }) => {
    expect(source).toContain(transport);
  },
);
