import { expect, it } from "@effect/vitest";

import { isNewIngress } from "./incident-ingress";

it("selects new ingress while leaving health, deletion, and reconciliation reachable", () => {
  const ingress = [
    ["PUT", "/v1/registration"],
    ["POST", "/webhooks/telegram"],
    ["POST", "/webhooks/whatsapp"],
    ["POST", "/v1/channel-link-invites/token/accept"],
    ["GET", "/agent/chat"],
  ] as const;
  for (const [method, path] of ingress) expect(isNewIngress(method, path)).toBe(true);
  const continuity = [
    ["GET", "/health"],
    ["GET", "/webhooks/whatsapp"],
    ["POST", "/webhooks/stripe"],
    ["POST", "/v1/account-deletion"],
    ["POST", "/api/auth/sign-in/email"],
  ] as const;
  for (const [method, path] of continuity) expect(isNewIngress(method, path)).toBe(false);
});
