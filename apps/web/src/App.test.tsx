import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AuthScreen } from "./components/auth-screen";
import { GetStartedScreen } from "./components/get-started-screen";
import { HomeScreen } from "./components/home-screen";
import { PlanDetails, PrivacyNotice } from "./components/public-information";

describe("App", () => {
  it("renders only the phone sign-in surface", () => {
    const html = renderToStaticMarkup(<AuthScreen onAuthenticated={() => undefined} />);

    expect(html).toContain("Continue by SMS");
    expect(html).toContain('autoComplete="tel-national"');
    expect(html).not.toContain("Email and password");
    expect(html).not.toContain('type="password"');
  });

  it("renders development credentials without replacing SMS authentication", () => {
    const html = renderToStaticMarkup(
      <AuthScreen enableCredentials onAuthenticated={() => undefined} />,
    );

    expect(html).toContain("Development access");
    expect(html).toContain("Email and password");
    expect(html).toContain("SMS code");
    expect(html).toContain('type="password"');
  });

  it("renders a public home page with authentication entry points", () => {
    const html = renderToStaticMarkup(<HomeScreen />);

    expect(html).toContain("Get the busy work out of your way.");
    expect(html).toContain('href="/login"');
    expect(html).toContain("Get started");
    expect(html).toContain("Sign in");
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
