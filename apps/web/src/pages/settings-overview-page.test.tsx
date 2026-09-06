// @vitest-environment happy-dom
/* oxlint-disable effecttsgo/async-function -- Testing Library and the simulated browser HTTP boundary own Promises. */

import { afterEach, expect, it } from "@effect/vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { AuthStateProvider, type AuthState } from "../auth-state";
import { rememberDocumentBuildSource } from "../components/agent-control-panel/document-build-source-storage";
import { withTestRouter } from "../testing/router";
import { SettingsOverviewPage } from "./settings-overview-page";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  sessionStorage.clear();
  localStorage.clear();
});

it("rechecks source ownership when the authenticated account changes and removes it on logout", async () => {
  let inspections = 0;
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (!url.includes("/v1/files/")) return Response.json({ items: [] });
    inspections += 1;
    if (inspections > 1) {
      return Response.json({ _tag: "FileUploadDenied", message: "not owned" }, { status: 403 });
    }
    return Response.json({
      fileId: "web:owned",
      fileName: "source.txt",
      mediaType: "text/plain",
      state: "ready",
    });
  };
  rememberDocumentBuildSource("web:owned");
  const page = render(overviewFor("first-account"));
  await screen.findByText("web:owned");
  page.rerender(overviewFor("second-account"));
  expect(screen.queryByText("web:owned")).toBeNull();
  await screen.findByText(/This source is not available to your account/u);
  expect(inspections).toBe(2);
  page.rerender(overviewFor(null));
  expect(screen.queryByText("Document Build source")).toBeNull();
});

const overviewFor = (id: string | null) => {
  const auth: AuthState = {
    data: id === null ? null : { user: { id, name: "Test User" } },
    isPending: false,
    refreshFromAuthority: () => Promise.resolve(),
  };
  return withTestRouter(
    <AuthStateProvider value={auth}>
      <SettingsOverviewPage />
    </AuthStateProvider>,
  );
};
