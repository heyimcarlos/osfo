import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AuthScreen } from "./components/auth-screen";
import { GetStartedScreen } from "./components/get-started-screen";
import { PlanDetails, PrivacyNotice } from "./components/public-information";
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

    expect(html).toContain("How can Osfo help?");
    expect(html).toContain("Both fields are optional");
    expect(html).toContain("Writing and email");
    expect(html).toContain("English");
    expect(html).toContain("Español");
    expect(html).toContain('autoComplete="name"');
  });

  it("renders the complete linked privacy notice and Plan details", () => {
    const privacy = renderToStaticMarkup(<PrivacyNotice />);
    const plans = renderToStaticMarkup(<PlanDetails />);
    const spanishPrivacy = renderToStaticMarkup(<PrivacyNotice locale="es" />);
    const spanishPlans = renderToStaticMarkup(<PlanDetails locale="es" />);

    expect(privacy).toContain("What Osfo stores");
    expect(privacy).toContain("Your choices and rights");
    expect(plans).toContain("CA$25 each month");
    expect(plans).toContain("30 per 30-day period");
    expect(spanishPrivacy).toContain("Qué guarda Osfo");
    expect(spanishPrivacy).toContain("Tus opciones y derechos");
    expect(spanishPlans).toContain("Planes y límites");
    expect(spanishPlans).toContain("30 por cada periodo de 30 días");
  });
});
