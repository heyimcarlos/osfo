// @vitest-environment happy-dom

/* oxlint-disable effecttsgo/node-builtin-import -- This browser route test uses a scoped real HTTP boundary. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { createServer } from "node:http";

import { AccountDeletionRequest } from "@osfo/api";
import { RouterProvider } from "@tanstack/react-router";
import { afterEach, expect, it, vi } from "@effect/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Effect, Schema } from "effect";

import { AuthStateProvider, type AuthState } from "./auth-state";
import { saveAccountDeletionReplay } from "./lib/account-deletion-replay";
import type { AccountDeletionReplayRequest as ReplayRequest } from "./lib/account-deletion-replay";

const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const ServerAddress = Schema.Struct({ port: Schema.Int.check(Schema.isGreaterThan(0)) });

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  if (localStorageDescriptor !== undefined) {
    Object.defineProperty(globalThis, "localStorage", localStorageDescriptor);
  }
  localStorage.clear();
});

it.effect("replays through the signed-out redirect from one captured storage access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const receivedBodies: Array<unknown> = [];
      const fixture = yield* Effect.acquireRelease(
        Effect.callback<{
          readonly origin: string;
          readonly server: ReturnType<typeof createServer>;
        }>((resume) => {
          const server = createServer((request, response) => {
            const responseHeaders = {
              "access-control-allow-credentials": "true",
              "access-control-allow-headers": "content-type",
              "access-control-allow-methods": "DELETE, OPTIONS",
              "access-control-allow-origin": globalThis.location.origin,
            };
            if (request.method === "OPTIONS") {
              response.writeHead(204, responseHeaders);
              response.end();
              return;
            }
            const chunks: Array<Uint8Array> = [];
            request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
            request.on("end", () => {
              receivedBodies.push(
                Schema.decodeSync(Schema.fromJsonString(AccountDeletionRequest))(
                  Buffer.concat(chunks).toString("utf8"),
                ),
              );
              response.writeHead(200, { ...responseHeaders, "content-type": "application/json" });
              response.end(JSON.stringify({ status: "deletion-pending" }));
            });
          });
          server.listen(0, "127.0.0.1", () =>
            resume(
              Schema.decodeUnknownEffect(ServerAddress)(server.address()).pipe(
                Effect.map(({ port }) => ({ origin: `http://127.0.0.1:${port}`, server })),
                Effect.orDie,
              ),
            ),
          );
        }),
        ({ server }) =>
          Effect.callback<void>((resume) => {
            server.close((error) => resume(error === undefined ? Effect.void : Effect.die(error)));
          }),
      );
      vi.stubEnv("VITE_API_URL", fixture.origin);

      const deletionRequest: ReplayRequest = {
        approval: {
          decision: "approved",
          presentation: {
            actionId: "account-delete:captured-route-action",
            confirmation: "delete-my-account",
            consequence: "Permanently delete this account and all of its data.",
            operation: "account.delete",
            title: "Delete Account",
          },
        },
        confirmation: "delete-my-account",
        presentationVersion: "account-deletion-v1",
        replayToken: "r".repeat(43),
      };
      const storage = localStorage;
      saveAccountDeletionReplay(storage, deletionRequest);
      let getterReads = 0;
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get: () => {
          getterReads += 1;
          if (getterReads > 1) throw new Error("localStorage getter read twice");
          return storage;
        },
      });
      globalThis.history.replaceState(null, "", "/");
      const { appRouter } = yield* Effect.promise(() => import("./router"));
      const signedOut: AuthState = {
        data: null,
        isPending: false,
        refreshFromAuthority: () => Promise.resolve(),
      };

      render(
        <AuthStateProvider value={signedOut}>
          <RouterProvider router={appRouter} />
        </AuthStateProvider>,
      );

      yield* Effect.promise(() =>
        waitFor(() =>
          expect(screen.getByRole("button", { name: "Retry Account Deletion" })).toBeTruthy(),
        ),
      );
      expect(screen.getByText("Delete Account")).toBeTruthy();
      expect(screen.getByText("Permanently delete this account and all of its data.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Retry Account Deletion" }));

      yield* Effect.promise(() => waitFor(() => expect(receivedBodies).toEqual([deletionRequest])));
      yield* Effect.promise(() => waitFor(() => expect(globalThis.location.pathname).toBe("/")));
      expect(storage.getItem("osfo-account-deletion-replay")).toBeNull();
      expect(getterReads).toBe(1);
    }),
  ),
);
