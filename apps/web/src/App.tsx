import { RouterProvider } from "@tanstack/react-router";

import { AuthStateProvider } from "./auth-state";
import {
  AgentConnectionProvider,
  parseAgentConnection,
  type AgentConnectionState,
} from "./lib/agent-connection";
import { authClient } from "./lib/auth-client";
import { appRouter } from "./router";

/** Osfo browser composition root. */
export function App({
  agentConnectionState = parseAgentConnection(import.meta.env.VITE_API_URL),
}: { readonly agentConnectionState?: AgentConnectionState } = {}) {
  const session = authClient.useSession();
  return (
    <AgentConnectionProvider value={agentConnectionState}>
      <AuthStateProvider value={session}>
        <RouterProvider router={appRouter} />
      </AuthStateProvider>
    </AgentConnectionProvider>
  );
}
