// oxlint-disable-next-line effecttsgo/node-builtin-import -- This Node-only parity audit reads checked-in deployment configuration.
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { hourlyMaintenanceCron, scheduledEmailReconciliationCron } from "./scheduled-lifecycle";

it("keeps minute recovery and hourly maintenance schedules in Wrangler and IaC", () => {
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const infrastructure = readFileSync(
    new URL("../../../infra/cloudflare/Worker.ts", import.meta.url),
    "utf8",
  );
  for (const cron of [scheduledEmailReconciliationCron, hourlyMaintenanceCron]) {
    expect(wrangler).toContain(JSON.stringify(cron));
    expect(infrastructure).toContain(JSON.stringify(cron));
  }
});
