// @vitest-environment happy-dom

import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import { AuthStateProvider, type AuthState } from "./auth-state";
import { parseAgentConnection } from "./lib/agent-connection";
import { parseBillingReturnSearch } from "./lib/billing-return";
import { createAppRouter } from "./router";

/* oxlint-disable effecttsgo/async-function -- Router navigation and Testing Library own browser Promises. */

const signedOut: AuthState = { data: null, isPending: false };
const pending: AuthState = { data: null, isPending: true };
const signedIn: AuthState = {
  data: {
    user: {
      name: "Osfo User",
      phoneNumber: "+14165550101",
    },
  },
  isPending: false,
};

afterEach(cleanup);

const renderAt = (path: string, authState: AuthState = signedOut) => {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ history });
  const view = render(
    <AuthStateProvider value={authState}>
      <RouterProvider router={router} />
    </AuthStateProvider>,
  );
  return { history, router, view };
};

describe("Osfo route tree", () => {
  it("matches public direct links and parameters", async () => {
    renderAt("/verify/invitation-token");

    await waitFor(() => expect(screen.getByText("This link is unavailable")).toBeTruthy());
  });

  it.each([
    ["/get-started", "How can Osfo help?"],
    ["/get-started?lang=es", "¿Cómo puede ayudarte Osfo?"],
    ["/privacy?lang=es", "Aviso de privacidad"],
    ["/plans", "Plans and allowances"],
  ])("preserves the public direct link %s", async (path, heading) => {
    renderAt(path);

    await waitFor(() => expect(screen.getByText(heading)).toBeTruthy());
  });

  it("parses hosted billing return search through the matched route", async () => {
    const { router } = renderAt("/billing/return?source=checkout&session_id=checkout-session");

    await waitFor(() => expect(screen.getByText("SMS code")).toBeTruthy());
    expect(router.state.matches.at(-1)?.search).toMatchObject({
      _tag: "Checkout",
      checkoutSessionId: "checkout-session",
    });
  });

  it("rejects illegal billing return and Agent configuration states", () => {
    expect(parseBillingReturnSearch({ source: "checkout" })).toEqual({ _tag: "Invalid" });
    expect(parseBillingReturnSearch({ session_id: "orphan" })).toEqual({ _tag: "Invalid" });
    expect(parseAgentConnection("ftp://example.com")).toEqual({
      _tag: "InvalidConfiguration",
    });
  });

  it("restores the document language after localized navigation", async () => {
    const { router } = renderAt("/privacy?lang=es");
    await waitFor(() => expect(document.documentElement.lang).toBe("es"));

    await act(() => router.navigate({ to: "/" }));
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
  });

  it("does not apply a locale query to an English-only route", async () => {
    renderAt("/login?lang=es");

    await waitFor(() => expect(screen.getByText("SMS code")).toBeTruthy());
    expect(document.documentElement.lang).toBe("en");
  });

  it("waits for Better Auth before it renders onboarding", async () => {
    const { router, view } = renderAt("/get-started", pending);

    await waitFor(() => expect(screen.getByText("Loading Osfo...")).toBeTruthy());
    expect(screen.queryByText("How can Osfo help?")).toBeNull();

    view.rerender(
      <AuthStateProvider value={signedOut}>
        <RouterProvider router={router} />
      </AuthStateProvider>,
    );
    await waitFor(() => expect(screen.getByText("How can Osfo help?")).toBeTruthy());
  });

  it("keeps an authenticated direct link across an auth transition", async () => {
    const { router, view } = renderAt("/settings/profile");

    await waitFor(() => expect(screen.getByText("SMS code")).toBeTruthy());

    view.rerender(
      <AuthStateProvider value={signedIn}>
        <RouterProvider router={router} />
      </AuthStateProvider>,
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "Profile" })).toBeTruthy());
    expect(router.state.location.pathname).toBe("/settings/profile");
  });

  it("uses router history for settings navigation and browser back", async () => {
    const { history, router } = renderAt("/settings", signedIn);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Manage your agent" })).toBeTruthy(),
    );
    expect(screen.queryByRole("navigation", { name: "Control center" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Settings" })).toBeNull();
    await act(() => router.navigate({ to: "/settings/channels" }));
    expect(screen.getByRole("heading", { name: "Messaging channel" })).toBeTruthy();

    act(() => history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    expect(screen.getByRole("heading", { name: "Manage your agent" })).toBeTruthy();

    act(() => history.forward());
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/channels"));
    expect(screen.getByRole("heading", { name: "Messaging channel" })).toBeTruthy();
  });

  it("restores a protected direct link after a refresh", async () => {
    const first = renderAt("/settings/privacy", signedIn);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Privacy" })).toBeTruthy());
    first.view.unmount();

    renderAt(first.router.state.location.href, signedIn);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Privacy" })).toBeTruthy());
  });

  it("renders a responsive master-detail shell with normal mobile back navigation", async () => {
    renderAt("/settings/privacy", signedIn);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Privacy" })).toBeTruthy());
    const settingsNavigation = screen.getByRole("navigation", { name: "Settings" });
    expect(settingsNavigation.className).toContain("max-md:hidden");
    const backLink = screen.getByRole("link", { name: "Back to settings" });
    expect(backLink.getAttribute("href")).toBe("/settings");
    expect(backLink.className).toContain("md:hidden");
  });

  it("shows a safe not-found page", async () => {
    renderAt("/not-a-real-page");

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Page not found" })).toBeTruthy(),
    );
  });
});
