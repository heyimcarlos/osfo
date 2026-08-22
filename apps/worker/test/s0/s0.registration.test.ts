/* oxlint-disable effecttsgo/global-fetch, effecttsgo/async-function -- throwaway S0 spike, plain Node fetch and async test bodies are intentional */
import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

const phoneNumber = "+15550001234";

interface LedgerEntry {
  readonly path: string;
  readonly to: string | null;
  readonly code: string | null;
}

const ledger = async (): Promise<ReadonlyArray<LedgerEntry>> => {
  const response = await fetch("http://127.0.0.1:9798/_ledger");
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error("ledger response was not an array");
  return data;
};

it("creates a real user and session headlessly through the phone flow", async () => {
  const sent = await exports.default.fetch(
    new Request("https://osfo.test/auth/phone-number/send-otp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://osfo.test" },
      body: JSON.stringify({ phoneNumber }),
    }),
  );
  expect(sent.status).toBe(200);
  const entries = await ledger();
  expect(entries.some((entry) => entry.path.endsWith("/Verifications"))).toBe(true);

  const verified = await exports.default.fetch(
    new Request("https://osfo.test/auth/phone-number/verify", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://osfo.test" },
      body: JSON.stringify({ phoneNumber, code: "424242" }),
    }),
  );
  expect(verified.status).toBe(200);

  const setCookie = verified.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("session_token");

  const session = await exports.default.fetch(
    new Request("https://osfo.test/auth/get-session", {
      headers: { cookie: setCookie.split(";")[0] ?? "" },
    }),
  );
  expect(session.status).toBe(200);
  const body: { user?: { phoneNumber?: string } } = await session.json();
  expect(body.user?.phoneNumber).toBe(phoneNumber);
});
