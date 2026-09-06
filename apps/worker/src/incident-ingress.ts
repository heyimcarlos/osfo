/** Ingress that can create a registration, channel link, or conversation. */
export const isNewIngress = (method: string, path: string): boolean =>
  (method === "PUT" && path === "/v1/registration") ||
  (method === "POST" &&
    (path === "/webhooks/telegram" ||
      path === "/webhooks/whatsapp" ||
      /^\/v1\/channel-link-invites\/[^/]+\/accept$/.test(path))) ||
  path === "/agent" ||
  path.startsWith("/agent/");
