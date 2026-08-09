import { RegistryProvider } from "@effect/atom-react";
import "@osfo/ui/globals.css";
import * as Exit from "effect/Exit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { makeThreadChat } from "./chat/atoms";
import { ConfigurationRequired } from "./configuration-required";
import {
  decodeReferenceClientConfig,
  decodeStoredReferenceClientAuthority,
  referenceClientAuthorityStorageKey,
} from "./reference-client-config";

const root = document.querySelector("#root");

if (!(root instanceof HTMLElement)) {
  throw new Error("Browser reference root element is missing");
}

const storedAuthority = decodeStoredReferenceClientAuthority(
  globalThis.sessionStorage.getItem(referenceClientAuthorityStorageKey),
);

const application = Exit.match(storedAuthority, {
  onFailure: () => <ConfigurationRequired />,
  onSuccess: (authority) => {
    const config = decodeReferenceClientConfig({
      ...authority,
      baseUrl: globalThis.location.origin,
      clientInstanceId:
        new URLSearchParams(globalThis.location.search).get("device") ??
        "local",
    });
    return Exit.match(config, {
      onFailure: () => <ConfigurationRequired />,
      onSuccess: (referenceConfig) => {
        const chat = makeThreadChat({
          authenticationToken: referenceConfig.authenticationToken,
          baseUrl: referenceConfig.baseUrl.toString(),
          clientInstanceId: referenceConfig.clientInstanceId,
          threadId: referenceConfig.threadId,
        });
        return (
          <RegistryProvider>
            <App chat={chat} threadId={referenceConfig.threadId} />
          </RegistryProvider>
        );
      },
    });
  },
});

createRoot(root).render(<StrictMode>{application}</StrictMode>);
