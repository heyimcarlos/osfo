import type { OsfoAgent } from "../src/agents/osfo/agent";

declare global {
  interface __BaseEnv_Env {
    readonly OSFO_AGENT_TEST_FACET: DurableObjectNamespace<OsfoAgent>;
  }
}

export type TestBindingName = "OSFO_AGENT_TEST_FACET";
