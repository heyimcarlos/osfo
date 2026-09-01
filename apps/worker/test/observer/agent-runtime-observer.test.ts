/* oxlint-disable effecttsgo/async-function, typescript/no-unsafe-type-assertion -- This test drives Miniflare's Worker and Durable Object Promise boundaries; the test binding is fixed by wrangler.observer.jsonc. */

import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { getSubAgentByName } from "agents";

import { OSFO_DIRECTORY_NAME } from "../../src/agents/osfo/identity";
import { UserId } from "../../src/domain";
import type { OsfoDirectory } from "../../src/worker";
import { OsfoAgent } from "../support/agent-runtime-observer";

it("resolves the observer Agent subclass and leaves absent Gmail evidence absent", async () => {
  // SAFETY: wrangler.observer.jsonc binds OSFO_DIRECTORY to OsfoDirectory for this test Worker.
  const runtimeEnv = env as typeof env & {
    readonly OSFO_DIRECTORY: DurableObjectNamespace<OsfoDirectory>;
  };
  const directory = runtimeEnv.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
  await directory.ensureAgent("observer-agent");
  const agent = await getSubAgentByName(directory, OsfoAgent, "observer-agent");
  const first = await agent.inspectImmediateGmailApprovalVerificationState(
    UserId.make("observer-user"),
  );
  const second = await agent.inspectImmediateGmailApprovalVerificationState(
    UserId.make("observer-user"),
  );
  const health = await SELF.fetch("https://observer.test/health");

  expect(health.status).toBe(200);
  expect(first).toEqual({
    _tag: "ImmediateGmailApprovalEvidenceUnavailable",
    approvalBindingCount: 0,
    presentationCount: 0,
    reason: "missing",
  });
  expect(second).toEqual({
    _tag: "ImmediateGmailApprovalEvidenceUnavailable",
    approvalBindingCount: 0,
    presentationCount: 0,
    reason: "missing",
  });
});
