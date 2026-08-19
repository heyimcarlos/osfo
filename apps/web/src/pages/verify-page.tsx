import type { InvitationResponse, OnboardingLocale } from "@osfo/api";
import { Button } from "@osfo/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader } from "@osfo/ui/components/card";
import { PageStatusCard } from "@osfo/ui/components/page-status-card";
import { useParams } from "@tanstack/react-router";
import { Effect, Exit } from "effect";
import { useEffect, useRef, useState } from "react";

import { useAuthState } from "../auth-state";
import { browserOnboardingLocale, OnboardingLayout } from "../components/onboarding-layout";
import {
  defaultPhoneAuthDependencies,
  PhoneAuthForm,
  type PhoneAuthDependencies,
} from "../components/phone-auth-form";
import { completeOnboarding, inspectRegistrationInvitation } from "../lib/api-client";

/* oxlint-disable eslint/no-underscore-dangle -- Typed Effect results use the standard _tag discriminator. */

/** Browser operations used by channel-first verification. */
export interface VerifyPageDependencies {
  readonly complete: typeof completeOnboarding;
  readonly inspectInvitation: typeof inspectRegistrationInvitation;
  readonly phoneAuth: PhoneAuthDependencies;
}

/** Optional route and dependency overrides for channel-first verification tests. */
export interface VerifyPageProps {
  readonly dependencies?: VerifyPageDependencies;
  readonly onReturnToChannel?: () => void;
  readonly token: string;
}

type VerifyState =
  | { readonly _tag: "Checking" }
  | { readonly _tag: "Complete"; readonly provider: "telegram" | "whatsapp" }
  | { readonly _tag: "Failed" }
  | {
      readonly _tag: "Phone";
      readonly invitation: InvitationResponse & {
        readonly provider: "telegram" | "whatsapp";
        readonly state: "live";
      };
    }
  | { readonly _tag: "Submitting"; readonly provider: "telegram" | "whatsapp" }
  | { readonly _tag: "Unavailable"; readonly provider: "telegram" | "whatsapp" | null };

/** Channel-first phone verification and automatic binding page. */
export function VerifyPage({
  dependencies = defaultDependencies,
  onReturnToChannel,
  token,
}: VerifyPageProps) {
  const session = useAuthState();
  const [locale, setLocale] = useState<OnboardingLocale>(browserOnboardingLocale);
  const [state, setState] = useState<VerifyState>({ _tag: "Checking" });
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    let active = true;
    void Effect.runPromiseExit(dependencies.inspectInvitation(token)).then((exit) => {
      if (!active) return;
      if (Exit.isFailure(exit) || exit.value.state !== "live" || exit.value.provider === null) {
        setState({
          _tag: "Unavailable",
          provider: Exit.isSuccess(exit) ? exit.value.provider : null,
        });
        return;
      }
      const invitation = {
        ...exit.value,
        provider: exit.value.provider,
        state: exit.value.state,
      };
      setLocale(invitation.locale);
      if (sessionRef.current.data === null) {
        setState({ _tag: "Phone", invitation });
        return;
      }
      void completeBinding(dependencies, token, invitation.locale, invitation.provider, setState);
    });
    return () => {
      active = false;
    };
  }, [dependencies, token]);

  const text = copy[locale];
  const provider =
    state._tag === "Complete" || state._tag === "Submitting" || state._tag === "Unavailable"
      ? state.provider
      : state._tag === "Phone"
        ? state.invitation.provider
        : null;
  const providerName = provider === "telegram" ? "Telegram" : "WhatsApp";

  return (
    <OnboardingLayout locale={locale} onLocaleChange={setLocale}>
      {state._tag === "Checking" ? (
        <PageStatusCard
          aria-live="polite"
          description={text.checkingBody}
          role="status"
          title={text.checkingTitle}
        />
      ) : null}

      {state._tag === "Unavailable" ? (
        <PageStatusCard
          description={text.unavailableBody}
          role="alert"
          title={text.unavailableTitle}
        />
      ) : null}

      {state._tag === "Phone" ? (
        <PhoneAuthForm
          dependencies={dependencies.phoneAuth}
          invitationToken={token}
          locale={locale}
          lockedPhoneNumber={state.invitation.maskedPhoneNumber !== null}
          {...(state.invitation.maskedPhoneNumber === null
            ? {}
            : { maskedPhoneNumber: state.invitation.maskedPhoneNumber })}
          onAuthenticated={() =>
            completeBinding(dependencies, token, locale, state.invitation.provider, setState)
          }
        />
      ) : null}

      {state._tag === "Submitting" ? (
        <PageStatusCard
          aria-live="polite"
          description={text.connectingBody.replace("{provider}", providerName)}
          role="status"
          title={text.connectingTitle}
        />
      ) : null}

      {state._tag === "Failed" ? (
        <PageStatusCard description={text.failedBody} role="alert" title={text.failedTitle} />
      ) : null}

      {state._tag === "Complete" ? (
        <Card className="w-full max-w-[34rem] bg-background shadow-[8px_8px_0_var(--foreground)]">
          <CardHeader>
            <p className="font-black text-xs uppercase tracking-[0.22em]">{text.complete}</p>
            <h1 className="text-4xl font-black uppercase leading-none">{text.readyTitle}</h1>
            <CardDescription>{text.readyBody.replace("{provider}", providerName)}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              className="w-full"
              type="button"
              onClick={() => {
                if (onReturnToChannel !== undefined) onReturnToChannel();
                else globalThis.history.back();
              }}
            >
              {text.returnTo.replace("{provider}", providerName)}
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </OnboardingLayout>
  );
}

/** TanStack Router adapter for the channel-first verification page. */
export function VerifyRoute() {
  const { token } = useParams({ from: "/verify/$token" });
  return <VerifyPage token={token} />;
}

const defaultDependencies: VerifyPageDependencies = {
  complete: completeOnboarding,
  inspectInvitation: inspectRegistrationInvitation,
  phoneAuth: defaultPhoneAuthDependencies,
};

const completeBinding = (
  dependencies: VerifyPageDependencies,
  token: string,
  locale: OnboardingLocale,
  provider: "telegram" | "whatsapp",
  setState: (state: VerifyState) => void,
) => {
  setState({ _tag: "Submitting", provider });
  return Effect.runPromiseExit(
    dependencies.complete({
      existingProfileChoice: "keep",
      helpAreas: [],
      invitationToken: token,
      locale,
      preferredName: null,
    }),
  ).then((exit) => {
    if (
      Exit.isFailure(exit) ||
      (exit.value.channel._tag !== "BindingCreated" &&
        exit.value.channel._tag !== "BindingExisting")
    ) {
      setState({ _tag: "Failed" });
      return copy[locale].failedBody;
    }
    setState({ _tag: "Complete", provider });
    return undefined;
  });
};

const copy = {
  en: {
    checkingBody: "Osfo is checking this channel invitation.",
    checkingTitle: "Checking your link",
    complete: "Phone verified",
    connectingBody: "Osfo is connecting your {provider} identity.",
    connectingTitle: "Connecting your channel",
    failedBody:
      "Osfo could not connect this channel. Request a new link if this invitation was already used.",
    failedTitle: "Connection not complete",
    readyBody: "Your phone is verified and your {provider} identity is connected.",
    readyTitle: "You are connected",
    returnTo: "Return to {provider}",
    unavailableBody: "Request a fresh verification link in your messaging app, then try again.",
    unavailableTitle: "This link is unavailable",
  },
  es: {
    checkingBody: "Osfo está comprobando esta invitación del canal.",
    checkingTitle: "Comprobando tu enlace",
    complete: "Teléfono verificado",
    connectingBody: "Osfo está conectando tu identidad de {provider}.",
    connectingTitle: "Conectando tu canal",
    failedBody:
      "Osfo no pudo conectar este canal. Pide un enlace nuevo si esta invitación ya se usó.",
    failedTitle: "Conexión incompleta",
    readyBody: "Tu teléfono está verificado y tu identidad de {provider} está conectada.",
    readyTitle: "Ya estás conectado",
    returnTo: "Volver a {provider}",
    unavailableBody:
      "Pide un enlace de verificación nuevo en tu aplicación de mensajería e inténtalo otra vez.",
    unavailableTitle: "Este enlace no está disponible",
  },
} as const;
