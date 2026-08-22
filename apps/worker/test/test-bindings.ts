import type { OsfoAgent } from "../src/agents/osfo/agent";
import type { CompanyAgent } from "../src/agents/osfo/company-agent";

declare global {
  interface __BaseEnv_Env {
    readonly COMPANY_AGENT_TEST_FACET: DurableObjectNamespace<CompanyAgent>;
    readonly OSFO_AGENT_TEST_FACET: DurableObjectNamespace<OsfoAgent>;
  }
}

export type TestBindingName = "COMPANY_AGENT_TEST_FACET" | "OSFO_AGENT_TEST_FACET";
