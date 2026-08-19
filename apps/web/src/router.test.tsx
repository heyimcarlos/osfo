// @vitest-environment happy-dom

import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { DateTime } from "effect";

import { AuthStateProvider, type AuthState } from "./auth-state";
import { parseBillingReturnSearch } from "./lib/billing-return";
import { createAppRouter } from "./router";

/* oxlint-disable effecttsgo/async-function -- Router navigation and Testing Library own browser Promises. */

const refreshFromAuthority = () => Promise.resolve();
const signedOut: AuthState = { data: null, isPending: false, refreshFromAuthority };
const pending: AuthState = { data: null, isPending: true, refreshFromAuthority };
const signedIn: AuthState = {
  data: {
    user: {
      name: "Osfo User",
      phoneNumber: "+14165550101",
      registrationCompletedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-18T12:00:00.000Z")),
    },
  },
  isPending: false,
  refreshFromAuthority,
};
const registrationIncomplete: AuthState = {
  data: {
    user: {
      name: "Osfo User",
      phoneNumber: "+14165550102",
      registrationCompletedAt: null,
    },
  },
  isPending: false,
  refreshFromAuthority,
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
  it("opens email-password sign-in without offering credential sign-up", async () => {
    renderAt("/login");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Email and password" })).toBeTruthy(),
    );
    act(() => screen.getByRole("button", { name: "Email and password" }).click());

    expect(screen.getByText(/New accounts must start with an SMS code/)).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.queryByText("Create account")).toBeNull();
  });

  it("matches public direct links and parameters", async () => {
    const { router } = renderAt("/verify/invitation-token");

    await waitFor(() => expect(screen.getByText("This link is unavailable")).toBeTruthy());
    expect(router.state.location.pathname).toBe("/verify/invitation-token");
  });

  it.each([
    ["/get-started", "What should Osfo call you?"],
    ["/get-started?lang=es", "¿Cómo quieres que te llame Osfo?"],
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

  it("rejects illegal billing return states", () => {
    expect(parseBillingReturnSearch({ source: "checkout" })).toEqual({
      _tag: "Invalid",
    });
    expect(parseBillingReturnSearch({ session_id: "orphan" })).toEqual({
      _tag: "Invalid",
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
    expect(screen.queryByText("What should Osfo call you?")).toBeNull();

    view.rerender(
      <AuthStateProvider value={signedOut}>
        <RouterProvider router={router} />
      </AuthStateProvider>,
    );
    await waitFor(() => expect(screen.getByText("What should Osfo call you?")).toBeTruthy());
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
    expect(screen.getByRole("heading", { name: "Add sign-in credentials" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/settings/profile");
  });

  it("routes an authenticated account without an Agent back through onboarding", async () => {
    const { router } = renderAt("/settings", registrationIncomplete);

    await waitFor(() => expect(screen.getByText("What should Osfo call you?")).toBeTruthy());
    expect(router.state.location.pathname).toBe("/get-started");
  });

  it("does not expose a web chat route", async () => {
    renderAt("/think", signedIn);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Page not found" })).toBeTruthy(),
    );
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
    const settingsNavigation = screen.getByRole("navigation", {
      name: "Settings",
    });
    const backLink = screen.getByRole("link", { name: "Back to dashboard" });
    expect(backLink.getAttribute("href")).toBe("/settings");
    expect(settingsNavigation.className).toContain("grid-cols-2");
  });

  it("shows a safe not-found page", async () => {
    renderAt("/not-a-real-page");

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Page not found" })).toBeTruthy(),
    );
  });
});
