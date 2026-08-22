/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/global-date, effecttsgo/new-promise -- throwaway S0 spike harness, plain Node http server is intentional */
import { createServer, type Server } from "node:http";

export interface TwilioLedgerEntry {
  readonly path: string;
  readonly to: string | null;
  readonly code: string | null;
}

const ledger: Array<TwilioLedgerEntry> = [];

let server: Server | undefined;

export const startTwilioEmulator = (port: number): Promise<void> =>
  new Promise((resolve) => {
    server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/_ledger") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(ledger));
        return;
      }
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const params = new URLSearchParams(body);
        ledger.push({
          path: pathname,
          to: params.get("To"),
          code: params.get("Code"),
        });
        if (request.url?.includes("VerificationCheck")) {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ valid: true, status: "approved" }));
        } else {
          response.statusCode = 201;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ status: "pending", sid: "VE-emulated" }));
        }
      });
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });

export const stopTwilioEmulator = (): Promise<void> =>
  new Promise((resolve) => {
    server?.close(() => resolve());
  });

export const twilioLedger = (): ReadonlyArray<TwilioLedgerEntry> => ledger;
