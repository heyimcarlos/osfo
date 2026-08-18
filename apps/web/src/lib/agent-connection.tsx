import { createContext, type ReactNode, useContext } from "react";

/** Valid WebSocket connection details for the Think Agent. */
export type AgentConnection = {
  readonly host: string;
  readonly protocol: "ws" | "wss";
};

/** Parsed Agent connection configuration available to the web composition tree. */
export type AgentConnectionState =
  | { readonly _tag: "Available"; readonly connection: AgentConnection }
  | { readonly _tag: "InvalidConfiguration" };

const AgentConnectionContext = createContext<AgentConnectionState>({
  _tag: "InvalidConfiguration",
});

/** Parse the Agent endpoint once at the browser composition boundary. */
export const parseAgentConnection = (apiUrl: string): AgentConnectionState => {
  if (!URL.canParse(apiUrl)) return { _tag: "InvalidConfiguration" };
  const url = new URL(apiUrl);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname.length === 0)
    return { _tag: "InvalidConfiguration" };
  return {
    _tag: "Available",
    connection: {
      host: url.host,
      protocol: url.protocol === "https:" ? "wss" : "ws",
    },
  };
};

/** Provide parsed Agent connection configuration to route-owned pages. */
export function AgentConnectionProvider({
  children,
  value,
}: {
  readonly children: ReactNode;
  readonly value: AgentConnectionState;
}) {
  return (
    <AgentConnectionContext.Provider value={value}>{children}</AgentConnectionContext.Provider>
  );
}

/** Read parsed Agent connection configuration. */
export const useAgentConnection = () => useContext(AgentConnectionContext);
