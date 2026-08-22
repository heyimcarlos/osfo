import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";

import { loadConfig } from "../../src/config";

it("rejects a malformed nonempty Company Conversation daily limit", () => {
  expect(() =>
    loadConfig({ ...env, COMPANY_CONVERSATION_DAILY_TURN_LIMIT: "not-a-number" }),
  ).toThrowError(
    "Worker configuration is invalid: COMPANY_CONVERSATION_DAILY_TURN_LIMIT must contain a positive integer",
  );
});
