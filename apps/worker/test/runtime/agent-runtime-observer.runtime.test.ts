/* oxlint-disable effecttsgo/async-function, typescript/no-unsafe-type-assertion -- This Promise test exercises a Worker fetch boundary with the smallest structural binding fixture and proves the omitted bindings are not touched. */

import { expect, it, vi } from "vitest";

import observer from "../support/agent-runtime-observer";

type TestObserverEnv = Parameters<typeof observer.fetch>[1];

it("does not resolve a conversation sub-Agent when the Directory has no existing Agent", async () => {
  const invokeSubAgent = vi.fn<(...args: Array<unknown>) => Promise<never>>(() =>
    Promise.reject(new Error("The observer attempted to resolve a missing child Agent")),
  );
  const directory = {
    _cf_invokeSubAgent: invokeSubAgent,
    inspectAgent: vi.fn<() => Promise<null>>(() => Promise.resolve(null)),
    inspectDocumentBuildSourceSnapshot: vi.fn<() => Promise<{ readonly _tag: "Unavailable" }>>(() =>
      Promise.resolve({ _tag: "Unavailable" }),
    ),
    inspectReminderVerificationState: vi.fn<() => Promise<null>>(() => Promise.resolve(null)),
    listAgents: vi.fn<() => Promise<Array<never>>>(() => Promise.resolve([])),
    pendingReminderWakeUpSources: vi.fn<() => Promise<Array<never>>>(() => Promise.resolve([])),
  };
  // SAFETY: every binding used by this request is supplied; omitted workflows and buckets are
  // unreachable because the request has none of their opt-in query parameters.
  const testEnv: TestObserverEnv = {
    ARTIFACTS: unreachableBinding<TestObserverEnv["ARTIFACTS"]>("ARTIFACTS"),
    DOCUMENT_BUILD_TIMER_WORKFLOW: unreachableBinding<
      TestObserverEnv["DOCUMENT_BUILD_TIMER_WORKFLOW"]
    >("DOCUMENT_BUILD_TIMER_WORKFLOW"),
    DOCUMENT_BUILD_WORKFLOW:
      unreachableBinding<TestObserverEnv["DOCUMENT_BUILD_WORKFLOW"]>("DOCUMENT_BUILD_WORKFLOW"),
    FILES: unreachableBinding<TestObserverEnv["FILES"]>("FILES"),
    OSFO_DIRECTORY: { getByName: () => directory },
    SCHEDULED_EMAIL_WORKFLOW: unreachableBinding<TestObserverEnv["SCHEDULED_EMAIL_WORKFLOW"]>(
      "SCHEDULED_EMAIL_WORKFLOW",
    ),
  };

  const response = await observer.fetch(
    new Request("https://observer.test/agent?agentId=missing-agent&conversation=1"),
    testEnv,
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    conversation: { _tag: "Unavailable", operation: "inspectAgent" },
    inspectable: false,
    registered: false,
  });
  expect(invokeSubAgent).not.toHaveBeenCalled();
});

const unreachableBinding = <Value>(name: string, _witness?: Value): Value => {
  const binding = new Proxy(
    {},
    {
      get: () => {
        throw new Error(`The observer unexpectedly accessed ${name}`);
      },
    },
  );
  // SAFETY: The proxy throws on every property access, so it cannot behave as a forged binding.
  return binding as Value;
};
