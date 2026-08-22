import type { HelpArea, RegistrationLocale } from "@osfo/api";
import { Button } from "@osfo/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader } from "@osfo/ui/components/card";
import { Input } from "@osfo/ui/components/input";
import { Label } from "@osfo/ui/components/label";
import { PageStatusCard } from "@osfo/ui/components/page-status-card";
import { Navigate, useNavigate, useSearch } from "@tanstack/react-router";
import { Effect, Exit } from "effect";
import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAuthState } from "../auth-state";
import { LoadingScreen } from "../components/loading-screen";
import { browserRegistrationLocale, RegistrationLayout } from "../components/registration-layout";
import {
  defaultPhoneAuthDependencies,
  PhoneAuthForm,
  type PhoneAuthDependencies,
} from "../components/phone-auth-form";
import { completeRegistration } from "../lib/api-client";

/* oxlint-disable eslint/no-underscore-dangle -- Typed page states use the standard _tag discriminator. */

/** Browser operations used by website-first registration. */
export interface GetStartedPageDependencies {
  readonly complete: typeof completeRegistration;
  readonly phoneAuth: PhoneAuthDependencies;
}

/** Optional dependency overrides for website-first registration tests. */
export interface GetStartedPageProps {
  readonly dependencies?: GetStartedPageDependencies;
  readonly initialLocale?: RegistrationLocale;
  readonly onComplete?: () => void;
}

type GetStartedState =
  | { readonly _tag: "HelpAreas" }
  | { readonly _tag: "Name" }
  | { readonly _tag: "Phone" }
  | { readonly _tag: "Submitting" }
  | { readonly _tag: "SubmissionFailed" };

/** Website-first registration page. */
export function GetStartedPage({
  dependencies = defaultDependencies,
  initialLocale,
  onComplete,
}: GetStartedPageProps = {}) {
  const navigate = useNavigate();
  const session = useAuthState();
  const [locale, setLocale] = useState<RegistrationLocale>(
    () => initialLocale ?? browserRegistrationLocale(),
  );
  const [preferredName, setPreferredName] = useState("");
  const [helpAreas, setHelpAreas] = useState<ReadonlyArray<HelpArea>>([]);
  const [state, setState] = useState<GetStartedState>({ _tag: "Name" });
  const errorRef = useRef<HTMLParagraphElement>(null);
  const text = copy[locale];

  useEffect(() => {
    if (state._tag === "SubmissionFailed") errorRef.current?.focus();
  }, [state]);

  if (session.isPending) return <LoadingScreen />;
  if (session.data?.user.registrationCompletedAt != null)
    return <Navigate replace to="/settings" />;

  const finish = () => {
    setState({ _tag: "Submitting" });
    void Effect.runPromiseExit(
      dependencies.complete({
        helpAreas,
        locale,
        preferredName: preferredName.trim() || null,
      }),
    ).then((exit) => {
      if (Exit.isFailure(exit)) {
        setState({ _tag: "SubmissionFailed" });
        return;
      }
      void session.refreshFromAuthority().then(() => {
        if (onComplete !== undefined) onComplete();
        else void navigate({ to: "/settings" });
      });
    });
  };

  return (
    <RegistrationLayout locale={locale} onLocaleChange={setLocale}>
      {state._tag === "Name" ? (
        <Card className="w-full max-w-[34rem] bg-background shadow-[8px_8px_0_var(--foreground)]">
          <CardHeader className="gap-3 border-b-2 border-border pb-5">
            <p className="font-black text-xs uppercase tracking-[0.22em]">{text.getStarted}</p>
            <h1 className="text-4xl font-black uppercase leading-none sm:text-5xl">
              {text.nameTitle}
            </h1>
            <CardDescription className="text-base font-medium text-foreground/75">
              {text.nameBody}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-6"
              onSubmit={(event) => {
                event.preventDefault();
                setState(session.data === null ? { _tag: "Phone" } : { _tag: "HelpAreas" });
              }}
            >
              <div className="space-y-2">
                <Label className="font-black uppercase" htmlFor="preferred-name">
                  {text.nameLabel}
                </Label>
                <Input
                  autoComplete="name"
                  id="preferred-name"
                  maxLength={80}
                  name="name"
                  value={preferredName}
                  onChange={(event) => setPreferredName(event.target.value)}
                />
              </div>
              <ContinueButton label={text.continue} />
            </form>
          </CardContent>
        </Card>
      ) : null}

      {state._tag === "Phone" ? (
        <PhoneAuthForm
          dependencies={dependencies.phoneAuth}
          locale={locale}
          onAuthenticated={() =>
            session.refreshFromAuthority().then(() => {
              setState({ _tag: "HelpAreas" });
              return undefined;
            })
          }
        />
      ) : null}

      {state._tag === "HelpAreas" ? (
        <Card className="w-full max-w-[34rem] bg-background shadow-[8px_8px_0_var(--foreground)]">
          <CardHeader className="gap-3 border-b-2 border-border pb-5">
            <p className="font-black text-xs uppercase tracking-[0.22em]">{text.lastStep}</p>
            <h1 className="text-4xl font-black uppercase leading-none sm:text-5xl">
              {text.helpTitle}
            </h1>
            <CardDescription className="text-base font-medium text-foreground/75">
              {text.helpBody}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-6"
              onSubmit={(event) => {
                event.preventDefault();
                finish();
              }}
            >
              <fieldset className="space-y-3">
                <legend className="sr-only">{text.helpTitle}</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {helpAreaOrder.map((area) => (
                    <label
                      className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border-2 border-border px-3 py-2 font-medium focus-within:ring-2 focus-within:ring-ring"
                      key={area}
                    >
                      <input
                        checked={helpAreas.includes(area)}
                        className="size-5 accent-primary"
                        type="checkbox"
                        onChange={() => setHelpAreas(toggleArea(helpAreas, area))}
                      />
                      {text.helpAreas[area]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <ContinueButton label={text.finishSetup} />
            </form>
          </CardContent>
        </Card>
      ) : null}

      {state._tag === "Submitting" ? (
        <PageStatusCard
          aria-live="polite"
          description={text.completingBody}
          role="status"
          title={text.completingTitle}
        />
      ) : null}

      {state._tag === "SubmissionFailed" ? (
        <Card className="w-full max-w-[34rem] bg-background shadow-[8px_8px_0_var(--foreground)]">
          <CardHeader>
            <h1 className="text-4xl font-black uppercase leading-none">{text.errorTitle}</h1>
            <CardDescription ref={errorRef} role="alert" tabIndex={-1}>
              {text.errorBody}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" type="button" onClick={finish}>
              {text.retry}
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </RegistrationLayout>
  );
}

/** TanStack Router adapter for the website-first registration page. */
export function GetStartedRoute() {
  const { lang } = useSearch({ from: "/get-started" });
  return <GetStartedPage {...(lang === undefined ? {} : { initialLocale: lang })} />;
}

const defaultDependencies: GetStartedPageDependencies = {
  complete: completeRegistration,
  phoneAuth: defaultPhoneAuthDependencies,
};

const ContinueButton = ({ label }: { readonly label: string }) => (
  <Button className="w-full justify-between border-2 font-black uppercase" type="submit">
    {label}
    <ArrowRight data-icon="inline-end" />
  </Button>
);

const helpAreaOrder: ReadonlyArray<HelpArea> = [
  "writing-email",
  "scheduling-reminders",
  "research",
  "files-documents",
  "money-planning",
  "something-else",
];

const toggleArea = (current: ReadonlyArray<HelpArea>, area: HelpArea) =>
  current.includes(area) ? current.filter((value) => value !== area) : [...current, area];

const copy = {
  en: {
    completingBody: "Osfo is creating your account and personal agent.",
    completingTitle: "Completing setup",
    continue: "Continue",
    errorBody: "Osfo could not complete setup. Try again.",
    errorTitle: "Setup not complete",
    finishSetup: "Finish setup",
    getStarted: "Get started",
    helpAreas: {
      "files-documents": "Files and documents",
      "money-planning": "Money and planning",
      research: "Research",
      "scheduling-reminders": "Scheduling and reminders",
      "something-else": "Something else",
      "writing-email": "Writing and email",
    },
    helpBody: "Choose any areas that you want your agent to know about. You can change them later.",
    helpTitle: "What would you like help with?",
    lastStep: "Last step",
    nameBody: "Enter the name that you want Osfo to use, or skip this for now.",
    nameLabel: "Your name",
    nameTitle: "What should Osfo call you?",
    retry: "Try again",
  },
  es: {
    completingBody: "Osfo está creando tu cuenta y tu agente personal.",
    completingTitle: "Completando la configuración",
    continue: "Continuar",
    errorBody: "Osfo no pudo completar la configuración. Inténtalo de nuevo.",
    errorTitle: "Configuración incompleta",
    finishSetup: "Terminar configuración",
    getStarted: "Comenzar",
    helpAreas: {
      "files-documents": "Archivos y documentos",
      "money-planning": "Dinero y planificación",
      research: "Investigación",
      "scheduling-reminders": "Agenda y recordatorios",
      "something-else": "Algo más",
      "writing-email": "Redacción y correo",
    },
    helpBody: "Elige las áreas que quieres que conozca tu agente. Puedes cambiarlas más tarde.",
    helpTitle: "¿Con qué quieres ayuda?",
    lastStep: "Último paso",
    nameBody: "Escribe el nombre que quieres que use Osfo, o sáltate este paso por ahora.",
    nameLabel: "Tu nombre",
    nameTitle: "¿Cómo quieres que te llame Osfo?",
    retry: "Intentar de nuevo",
  },
} as const;
