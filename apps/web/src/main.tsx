import "@osfo/ui/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { parseAgentConnection } from "./lib/agent-connection";

const root = document.querySelector("#root");

if (!(root instanceof HTMLElement)) {
  throw new Error("Web root element is missing");
}

const agentConnection = parseAgentConnection(import.meta.env.VITE_API_URL);

createRoot(root).render(
  <StrictMode>
    <App agentConnectionState={agentConnection} />
  </StrictMode>,
);
