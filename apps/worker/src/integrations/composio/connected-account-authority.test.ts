/* oxlint-disable effecttsgo/async-function -- Promise fakes model the Composio API boundary. */
import { describe, expect, it } from "vitest";

import { revoke } from "./connected-account-authority";

describe("Composio connected account authority", () => {
  it("accepts only the exact synchronously revoked connection", async () => {
    const paths: Array<string> = [];
    await revoke(
      {
        post: async (path) => {
          paths.push(path);
          return { id: "connection-1", status: "REVOKED" };
        },
      },
      "connection-1",
    );
    expect(paths).toEqual(["/api/v3.1/connected_accounts/connection-1/revoke"]);
  });

  it("rejects another identity or a non-revoked status", async () => {
    await expect(
      revoke(
        { post: async () => ({ id: "another-connection", status: "REVOKED" }) },
        "connection-1",
      ),
    ).rejects.toThrow("different connected account");
    await expect(
      revoke({ post: async () => ({ id: "connection-1", status: "ACTIVE" }) }, "connection-1"),
    ).rejects.toThrow("status");
  });
});
