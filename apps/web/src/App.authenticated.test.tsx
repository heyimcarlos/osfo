// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "@effect/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

/* oxlint-disable effecttsgo/async-function -- Testing Library and the Better Auth HTTP boundary own browser Promises. */

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("authenticated App", () => {
  it("renders a masked phone without exposing the internal placeholder", async () => {
    globalThis.fetch = async () =>
      Response.json({
        session: {
          createdAt: "2026-08-16T00:00:00.000Z",
          expiresAt: "2026-09-01T00:00:00.000Z",
          id: "session-web-test",
          token: "session-web-test-token",
          updatedAt: "2026-08-16T00:00:00.000Z",
          userId: "user-web-test",
        },
        user: {
          createdAt: "2026-08-16T00:00:00.000Z",
          email: "14165550101@phone-user.osfo.invalid",
          emailVerified: false,
          id: "user-web-test",
          name: "14165550101@phone-user.osfo.invalid",
          phoneNumber: "+14165550101",
          phoneNumberVerified: true,
          updatedAt: "2026-08-16T00:00:00.000Z",
        },
      });
    globalThis.history.replaceState(null, "", "/settings/profile");
    const { App } = await import("./App");

    render(<App />);

    await waitFor(() => expect(screen.getByText("••••••••0101")).toBeTruthy());
    expect(screen.queryByText("14165550101@phone-user.osfo.invalid")).toBeNull();
  });
});
