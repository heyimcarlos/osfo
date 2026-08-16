import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AuthScreen } from "./components/auth-screen";
import { GetStartedScreen } from "./components/get-started-screen";
import { ChatPreview } from "./App";

describe("App", () => {
  it("renders the TryAgent-inspired credential sign-in surface", () => {
    const html = renderToStaticMarkup(<AuthScreen onAuthenticated={() => undefined} />);

    expect(html).toContain("Welcome back");
    expect(html).toContain("Email and password");
    expect(html).toContain("SMS code");
    expect(html).toContain('autoComplete="current-password"');
  });

  it("renders the reusable chat after authentication", () => {
    const html = renderToStaticMarkup(<ChatPreview userLabel="tester@osfo.test" />);

    expect(html).toContain("Reusable chat interface");
    expect(html).toContain("Hi, I am Osfo.");
    expect(html).toContain('placeholder="Message Osfo"');
    expect(html).toContain("What would you like to work on?");
    expect(html).toContain("tester@osfo.test");
    expect(html).toContain("Sign out");
  });

  it("renders the public phone-first registration entry", () => {
    const html = renderToStaticMarkup(<GetStartedScreen onComplete={() => undefined} />);

    expect(html).toContain("What should Osfo call you?");
    expect(html).toContain("No card is required");
    expect(html).toContain('autoComplete="name"');
  });
});
