import type { HelpArea, InvitationResponse, OnboardingLocale, OnboardingResponse } from "@osfo/api";
import { Button } from "@osfo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@osfo/ui/components/card";
import { Input } from "@osfo/ui/components/input";
import { Label } from "@osfo/ui/components/label";
import { Effect, Exit } from "effect";
import { ArrowRight, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { completeOnboarding, inspectRegistrationInvitation } from "../lib/api-client";
import {
  defaultPhoneAuthDependencies,
  PhoneAuthForm,
  type PhoneAuthDependencies,
} from "./phone-auth-form";

/* oxlint-disable eslint/no-underscore-dangle -- Typed Effect API unions use the standard _tag discriminator. */

interface GetStartedScreenProps {
  readonly dependencies?: GetStartedDependencies;
  readonly enrollmentProvider?: "telegram" | "whatsapp";
  readonly invitationToken?: string;
  readonly isAuthenticated?: boolean;
  readonly onComplete: () => void;
}

/** Browser operations used by the onboarding presentation. */
export interface GetStartedDependencies {
  readonly complete: typeof completeOnboarding;
  readonly inspectInvitation: typeof inspectRegistrationInvitation;
  readonly phoneAuth: PhoneAuthDependencies;
}

type SubmissionReturn = "ExistingProfile" | "Plan";

type OnboardingState =
  | { readonly _tag: "Complete"; readonly result: OnboardingResponse }
  | { readonly _tag: "EnrollmentPending"; readonly enrollmentUrl: URL }
  | { readonly _tag: "ExistingProfile"; readonly result: OnboardingResponse }
  | { readonly _tag: "Failed"; readonly message: string; readonly returnTo: SubmissionReturn }
  | { readonly _tag: "InvitationLoading" }
  | { readonly _tag: "InvitationUnavailable" }
  | { readonly _tag: "Notice" }
  | { readonly _tag: "Phone" }
  | { readonly _tag: "Plan" }
  | { readonly _tag: "Profile" }
  | { readonly _tag: "RegistrationComplete" }
  | { readonly _tag: "Submitting"; readonly returnTo: SubmissionReturn };

/** Complete localized phone-first web and invited messaging registration journey. */
export function GetStartedScreen({
  dependencies = defaultDependencies,
  enrollmentProvider = "whatsapp",
  invitationToken,
  isAuthenticated = false,
  onComplete,
}: GetStartedScreenProps) {
  const [locale, setLocale] = useState<OnboardingLocale>(() => browserLocale());
  const [preferredName, setPreferredName] = useState("");
  const [helpAreas, setHelpAreas] = useState<ReadonlyArray<HelpArea>>([]);
  const [state, setState] = useState<OnboardingState>(() =>
    invitationToken === undefined ? { _tag: "Profile" } : { _tag: "InvitationLoading" },
  );
  const [invitation, setInvitation] = useState<InvitationResponse>();
  const [bindingConsent, setBindingConsent] = useState<"accepted" | "refused" | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const provider =
    state._tag === "EnrollmentPending"
      ? providerFromEnrollmentUrl(state.enrollmentUrl)
      : (invitation?.provider ?? enrollmentProvider);
  const text =
    provider === "telegram" ? { ...copy[locale], ...telegramCopy[locale] } : copy[locale];

  useEffect(() => {
    if (invitationToken === undefined) return;
    void Effect.runPromiseExit(dependencies.inspectInvitation(invitationToken)).then((exit) => {
      if (Exit.isFailure(exit) || exit.value.state !== "live") {
        setState({ _tag: "InvitationUnavailable" });
        return;
      }
      setInvitation(exit.value);
      setLocale(exit.value.locale);
      setState({ _tag: "Profile" });
    });
  }, [dependencies, invitationToken]);

  useEffect(() => {
    if (state._tag === "Failed") errorRef.current?.focus();
  }, [state]);

  const finish = (existingProfileChoice: "apply" | "keep" | null) => {
    const returnTo = existingProfileChoice === null ? "Plan" : "ExistingProfile";
    if (invitationToken !== undefined && bindingConsent === null) {
      setState({ _tag: "Failed", message: text.chooseConsent, returnTo });
      return;
    }
    setState({ _tag: "Submitting", returnTo });
    const webEnrollmentToken = invitationToken === undefined ? getWebEnrollmentToken() : null;
    void Effect.runPromiseExit(
      dependencies.complete({
        bindingConsent:
          invitationToken === undefined ? "web-enrollment" : (bindingConsent ?? "refused"),
        existingProfileChoice,
        helpAreas,
        invitationToken: invitationToken ?? null,
        locale,
        preferredName: preferredName.trim() === "" ? null : preferredName.trim(),
        webEnrollmentToken,
      }),
    ).then((exit) => {
      if (Exit.isFailure(exit)) {
        setState({ _tag: "Failed", message: text.completeError, returnTo });
        return;
      }
      if (exit.value.profileConfirmationRequired) {
        setState({ _tag: "ExistingProfile", result: exit.value });
        return;
      }
      switch (exit.value.channel._tag) {
        case "EnrollmentPending":
          setState({
            _tag: "EnrollmentPending",
            enrollmentUrl: exit.value.channel.enrollmentUrl,
          });
          return;
        case "BindingCreated":
        case "BindingExisting":
          setState({ _tag: "Complete", result: exit.value });
          return;
        case "ConsentRefused":
          setState({ _tag: "RegistrationComplete" });
          return;
        case "ProfileConfirmationPending":
          setState({ _tag: "ExistingProfile", result: exit.value });
      }
    });
  };

  if (state._tag === "InvitationLoading" || state._tag === "InvitationUnavailable") {
    return (
      <Shell locale={locale} onLocaleChange={setLocale}>
        <StatusCard
          description={
            state._tag === "InvitationUnavailable" ? text.linkUnavailableBody : text.loadingBody
          }
          title={state._tag === "InvitationUnavailable" ? text.linkUnavailable : text.loading}
        />
      </Shell>
    );
  }

  const submittingTo = state._tag === "Submitting" ? state.returnTo : null;
  const failedAt = state._tag === "Failed" ? state.returnTo : null;
  const requestError = state._tag === "Failed" ? state.message : undefined;

  return (
    <Shell locale={locale} onLocaleChange={setLocale}>
      {state._tag === "Profile" ? (
        <Card className="w-full max-w-[34rem] bg-background shadow-[8px_8px_0_var(--foreground)]">
          <CardHeader className="gap-3 border-b-2 border-border pb-5">
            <p className="font-black text-xs uppercase tracking-[0.22em]">{text.getStarted}</p>
            <CardTitle className="text-4xl uppercase leading-none sm:text-5xl">
              {text.profileTitle}
            </CardTitle>
            <CardDescription className="text-base font-medium text-foreground/75">
              {text.profileBody}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-6"
              onSubmit={(event) => {
                event.preventDefault();
                setState({ _tag: "Notice" });
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
                  placeholder={text.optional}
                  value={preferredName}
                  onChange={(event) => setPreferredName(event.target.value)}
                />
              </div>
              <fieldset className="space-y-3">
                <legend className="font-black uppercase">{text.helpLegend}</legend>
                <p className="text-sm text-muted-foreground">{text.helpHint}</p>
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
              <ContinueButton label={text.continue} />
            </form>
          </CardContent>
        </Card>
      ) : null}

      {state._tag === "Notice" ? (
        <Card className="w-full max-w-[34rem] bg-background shadow-[8px_8px_0_var(--foreground)]">
          <CardHeader className="gap-3 border-b-2 border-border pb-5">
            <p className="font-black text-xs uppercase tracking-[0.22em]">{text.beforeSms}</p>
            <CardTitle className="text-4xl uppercase leading-none">{text.noticeTitle}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed">
              <li>{text.aiNotice}</li>
              <li>{text.storageNotice}</li>
              <li>{text.whatsAppNotice}</li>
              <li>{text.stopNotice}</li>
            </ul>
            <p className="text-sm">
              <a className="font-bold underline" href={`/privacy?lang=${locale}`}>
                {text.privacyLink}
              </a>
            </p>
            <Button
              className="w-full justify-between border-2 font-black uppercase"
              type="button"
              onClick={() => setState({ _tag: isAuthenticated ? "Plan" : "Phone" })}
            >
              {text.continueSms}
              <ArrowRight data-icon="inline-end" />
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {state._tag === "Phone" ? (
        <PhoneAuthForm
          dependencies={dependencies.phoneAuth}
          {...(invitationToken === undefined || invitation?.maskedPhoneNumber == null
            ? {}
            : { invitationToken })}
          locale={locale}
          lockedPhoneNumber={invitation?.maskedPhoneNumber != null}
          {...(invitation?.maskedPhoneNumber === null || invitation?.maskedPhoneNumber === undefined
            ? {}
            : { maskedPhoneNumber: invitation.maskedPhoneNumber })}
          onAuthenticated={() => setState({ _tag: "Plan" })}
        />
      ) : null}

      {state._tag === "Plan" || submittingTo === "Plan" || failedAt === "Plan" ? (
        <Card className="w-full max-w-[34rem] bg-background shadow-[8px_8px_0_var(--foreground)]">
          <CardHeader className="gap-3 border-b-2 border-border pb-5">
            <p className="font-black text-xs uppercase tracking-[0.22em]">{text.finalStep}</p>
            <CardTitle className="text-4xl uppercase leading-none">{text.freeTitle}</CardTitle>
            <CardDescription className="text-base font-bold text-foreground">
              {text.freeDisclosure}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <a
              className="inline-flex items-center gap-1 font-bold underline"
              href={`/plans?lang=${locale}`}
            >
              {text.planLink} <ExternalLink className="size-4" aria-hidden="true" />
            </a>
            {invitationToken !== undefined ? (
              <fieldset className="space-y-3">
                <legend className="font-black uppercase">{text.bindingTitle}</legend>
                <p className="text-sm text-muted-foreground">{text.bindingBody}</p>
                {(["accepted", "refused"] as const).map((choice) => (
                  <label className="flex min-h-11 items-center gap-3" key={choice}>
                    <input
                      checked={bindingConsent === choice}
                      className="size-5 accent-primary"
                      name="binding-consent"
                      type="radio"
                      onChange={() => setBindingConsent(choice)}
                    />
                    {choice === "accepted" ? text.bindAccept : text.bindRefuse}
                  </label>
                ))}
              </fieldset>
            ) : (
              <p className="text-sm leading-relaxed">{text.enrollmentNotice}</p>
            )}
            <ErrorSummary message={requestError} paragraphRef={errorRef} />
            <Button
              className="w-full justify-between border-2 font-black uppercase"
              disabled={submittingTo === "Plan"}
              type="button"
              onClick={() => finish(null)}
            >
              {submittingTo === "Plan" ? text.working : text.confirmFree}
              <ArrowRight data-icon="inline-end" />
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {state._tag === "ExistingProfile" ||
      submittingTo === "ExistingProfile" ||
      failedAt === "ExistingProfile" ? (
        <Card className="w-full max-w-[34rem] bg-background shadow-[8px_8px_0_var(--foreground)]">
          <CardHeader>
            <CardTitle className="text-4xl uppercase leading-none">{text.existingTitle}</CardTitle>
            <CardDescription>{text.existingBody}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ErrorSummary message={requestError} paragraphRef={errorRef} />
            <Button
              disabled={submittingTo === "ExistingProfile"}
              type="button"
              onClick={() => finish("apply")}
            >
              {text.applyProfile}
            </Button>
            <Button
              disabled={submittingTo === "ExistingProfile"}
              type="button"
              variant="outline"
              onClick={() => finish("keep")}
            >
              {text.keepProfile}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {state._tag === "EnrollmentPending" ? (
        <Card className="w-full max-w-[34rem] bg-background shadow-[8px_8px_0_var(--foreground)]">
          <CardHeader>
            <p className="font-black text-xs uppercase tracking-[0.22em]">{text.registered}</p>
            <CardTitle className="text-4xl uppercase leading-none">{text.pendingTitle}</CardTitle>
            <CardDescription>{text.pendingBody}</CardDescription>
          </CardHeader>
          <CardContent>
            <a
              className="inline-flex min-h-11 w-full items-center justify-between rounded-lg bg-primary px-4 font-black uppercase text-primary-foreground outline-none hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50"
              href={state.enrollmentUrl.href}
            >
              {text.continueWhatsApp}
              <ExternalLink data-icon="inline-end" />
            </a>
          </CardContent>
        </Card>
      ) : null}

      {state._tag === "Complete" ? (
        <StatusCardWithAction
          action={text.finish}
          description={text.readyBody}
          eyebrow={text.complete}
          onAction={onComplete}
          title={text.readyTitle}
        />
      ) : null}

      {state._tag === "RegistrationComplete" ? (
        <StatusCardWithAction
          action={text.finish}
          description={text.registrationCompleteBody}
          eyebrow={text.registered}
          onAction={onComplete}
          title={text.registrationCompleteTitle}
        />
      ) : null}
    </Shell>
  );
}

const defaultDependencies: GetStartedDependencies = {
  complete: completeOnboarding,
  inspectInvitation: inspectRegistrationInvitation,
  phoneAuth: defaultPhoneAuthDependencies,
};

function Shell({
  children,
  locale,
  onLocaleChange,
}: {
  readonly children: React.ReactNode;
  readonly locale: OnboardingLocale;
  readonly onLocaleChange: (locale: OnboardingLocale) => void;
}) {
  useEffect(() => {
    globalThis.document?.documentElement.setAttribute("lang", locale);
  }, [locale]);

  return (
    <main className="flex min-h-dvh flex-col bg-[radial-gradient(circle_at_top,oklch(0.96_0.035_250),oklch(0.985_0.006_250)_42%,oklch(0.965_0.008_250))] text-foreground">
      <div className="mx-auto flex w-full max-w-[36rem] flex-1 flex-col items-center justify-center gap-6 px-5 py-10">
        <div className="flex w-full items-center justify-between gap-4">
          <div className="flex items-center gap-3" aria-label="Osfo">
            <span className="grid size-14 place-items-center rounded-full bg-primary text-2xl font-black text-primary-foreground shadow-lg">
              O
            </span>
            <span className="text-3xl font-black tracking-tight">Osfo</span>
          </div>
          <Label className="sr-only" htmlFor="onboarding-language">
            Language
          </Label>
          <select
            className="min-h-11 rounded-md border-2 border-border bg-background px-3 font-bold"
            id="onboarding-language"
            value={locale}
            onChange={(event) => onLocaleChange(event.target.value === "es" ? "es" : "en")}
          >
            <option value="en">English</option>
            <option value="es">Español</option>
          </select>
        </div>
        {children}
      </div>
    </main>
  );
}

const ContinueButton = ({ label }: { readonly label: string }) => (
  <Button className="w-full justify-between border-2 font-black uppercase" type="submit">
    {label}
    <ArrowRight data-icon="inline-end" />
  </Button>
);

const ErrorSummary = ({
  message,
  paragraphRef,
}: {
  readonly message: string | undefined;
  readonly paragraphRef: React.Ref<HTMLParagraphElement>;
}) =>
  message === undefined ? null : (
    <p
      className="rounded-md border-2 border-destructive p-3 font-medium text-destructive"
      ref={paragraphRef}
      role="alert"
      tabIndex={-1}
    >
      {message}
    </p>
  );

const StatusCard = ({
  description,
  title,
}: {
  readonly description: string;
  readonly title: string;
}) => (
  <Card className="w-full max-w-[34rem] bg-background shadow-[8px_8px_0_var(--foreground)]">
    <CardHeader>
      <CardTitle className="text-4xl uppercase leading-none">{title}</CardTitle>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
  </Card>
);

const StatusCardWithAction = ({
  action,
  description,
  eyebrow,
  onAction,
  title,
}: {
  readonly action: string;
  readonly description: string;
  readonly eyebrow: string;
  readonly onAction: () => void;
  readonly title: string;
}) => (
  <Card className="w-full max-w-[34rem] bg-background shadow-[8px_8px_0_var(--foreground)]">
    <CardHeader>
      <p className="font-black text-xs uppercase tracking-[0.22em]">{eyebrow}</p>
      <CardTitle className="text-4xl uppercase leading-none">{title}</CardTitle>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
    <CardContent>
      <Button className="w-full" type="button" onClick={onAction}>
        {action}
      </Button>
    </CardContent>
  </Card>
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

const browserLocale = (): OnboardingLocale =>
  new URLSearchParams(globalThis.location?.search).get("lang") === "es" ||
  globalThis.navigator?.language.toLowerCase().startsWith("es")
    ? "es"
    : "en";

const getWebEnrollmentToken = (): string => {
  const key = "osfo-web-enrollment-token";
  const stored = globalThis.sessionStorage?.getItem(key);
  if (stored !== null && stored !== undefined && /^[0-9a-f]{64}$/u.test(stored)) {
    return stored;
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  globalThis.sessionStorage?.setItem(key, token);
  return token;
};

const providerFromEnrollmentUrl = (url: URL): "telegram" | "whatsapp" =>
  url.hostname.toLowerCase() === "t.me" ? "telegram" : "whatsapp";

const copy = {
  en: {
    aiNotice: "Osfo uses AI to process setup details and future messages.",
    applyProfile: "Apply the details I entered",
    beforeSms: "Before phone verification",
    bindAccept: "Connect this invited WhatsApp identity to my Osfo account.",
    bindRefuse: "Do not connect this WhatsApp identity.",
    bindingBody:
      "SMS verification and WhatsApp identity are separate evidence. This choice is not preselected.",
    bindingTitle: "WhatsApp binding consent",
    chooseConsent: "Choose whether to connect the invited WhatsApp identity.",
    complete: "Setup complete",
    completeError:
      "Osfo could not complete setup. Try again. If the identity is already connected elsewhere, contact support.",
    confirmFree: "Confirm Free and finish",
    continue: "Continue",
    continueSms: "Continue to phone verification",
    continueWhatsApp: "Continue in WhatsApp",
    enrollmentNotice:
      "Continue in WhatsApp will send one enrollment message. Only that provider-authenticated message can connect your WhatsApp identity.",
    existingBody:
      "This phone already belongs to an Osfo user. Choose whether to apply the optional details that you entered.",
    existingTitle: "Keep or update your profile",
    finalStep: "Final confirmation",
    finish: "Finish",
    freeDisclosure:
      "You are starting on Free. No card is required. You get 30 messages every 30 days.",
    freeTitle: "Start on Free",
    getStarted: "Get started",
    helpAreas: {
      "files-documents": "Files and documents",
      "money-planning": "Money and planning",
      research: "Research",
      "scheduling-reminders": "Scheduling and reminders",
      "something-else": "Something else",
      "writing-email": "Writing and email",
    },
    helpHint:
      "Optional. These choices shape the first response. They do not start work or grant authority.",
    helpLegend: "What would you like help with?",
    keepProfile: "Keep my existing profile",
    linkUnavailable: "This link is unavailable",
    linkUnavailableBody: "Request a fresh registration link in your messaging app, then try again.",
    loading: "Checking your link",
    loadingBody: "Osfo is checking this registration invitation.",
    nameLabel: "Preferred name",
    noticeTitle: "How setup works",
    optional: "Optional",
    pendingBody:
      "Registration is complete, but your WhatsApp connection is pending. Send the enrollment message to connect your WhatsApp identity.",
    pendingTitle: "WhatsApp connection pending",
    planLink: "View plan and allowance details",
    privacyLink: "Read the complete privacy notice",
    profileBody: "Both fields are optional. You can edit or erase accepted profile facts later.",
    profileTitle: "How can Osfo help?",
    readyBody: "Your personal Osfo Agent is ready. It will ask what you want to work on first.",
    readyTitle: "You are ready",
    registered: "Registration complete",
    registrationCompleteBody:
      "Your registration is complete. You chose not to connect the invited WhatsApp identity.",
    registrationCompleteTitle: "Registration complete",
    stopNotice:
      "Before proactive WhatsApp messages begin, Osfo explains how to stop them. You can reply STOP at any time.",
    storageNotice:
      "Osfo stores messages and the optional profile facts that you accept. Temporary registration dialogue is deleted.",
    whatsAppNotice:
      "WhatsApp processes channel messages. A Channel Binding is required so Osfo can route an authenticated sender to the correct user.",
    working: "Working...",
  },
  es: {
    aiNotice: "Osfo usa IA para procesar los datos de configuración y los mensajes futuros.",
    applyProfile: "Aplicar los datos que escribí",
    beforeSms: "Antes de verificar el teléfono",
    bindAccept: "Conectar esta identidad de WhatsApp invitada con mi cuenta de Osfo.",
    bindRefuse: "No conectar esta identidad de WhatsApp.",
    bindingBody:
      "La verificación por SMS y la identidad de WhatsApp son pruebas separadas. Esta opción no está preseleccionada.",
    bindingTitle: "Consentimiento de conexión de WhatsApp",
    chooseConsent: "Elige si quieres conectar la identidad de WhatsApp invitada.",
    complete: "Configuración completa",
    completeError:
      "Osfo no pudo completar la configuración. Inténtalo de nuevo. Si la identidad ya está conectada, contacta con soporte.",
    confirmFree: "Confirmar Free y terminar",
    continue: "Continuar",
    continueSms: "Continuar con la verificación",
    continueWhatsApp: "Continuar en WhatsApp",
    enrollmentNotice:
      "Continuar en WhatsApp enviará un mensaje de inscripción. Solo ese mensaje autenticado por el proveedor puede conectar tu identidad.",
    existingBody:
      "Este teléfono ya pertenece a un usuario de Osfo. Elige si quieres aplicar los datos opcionales que escribiste.",
    existingTitle: "Conserva o actualiza tu perfil",
    finalStep: "Confirmación final",
    finish: "Terminar",
    freeDisclosure: "Empiezas con Free. No necesitas tarjeta. Recibes 30 mensajes cada 30 días.",
    freeTitle: "Empieza con Free",
    getStarted: "Comenzar",
    helpAreas: {
      "files-documents": "Archivos y documentos",
      "money-planning": "Dinero y planificación",
      research: "Investigación",
      "scheduling-reminders": "Agenda y recordatorios",
      "something-else": "Algo más",
      "writing-email": "Redacción y correo",
    },
    helpHint:
      "Opcional. Estas opciones dan forma a la primera respuesta. No inician trabajo ni conceden autoridad.",
    helpLegend: "¿Con qué quieres ayuda?",
    keepProfile: "Conservar mi perfil actual",
    linkUnavailable: "Este enlace no está disponible",
    linkUnavailableBody:
      "Pide un nuevo enlace de registro en tu aplicación de mensajería e inténtalo de nuevo.",
    loading: "Comprobando tu enlace",
    loadingBody: "Osfo está comprobando esta invitación de registro.",
    nameLabel: "Nombre preferido",
    noticeTitle: "Cómo funciona la configuración",
    optional: "Opcional",
    pendingBody:
      "El registro está completo, pero la conexión de WhatsApp está pendiente. Envía el mensaje de inscripción para conectar tu identidad de WhatsApp.",
    pendingTitle: "Conexión de WhatsApp pendiente",
    planLink: "Ver detalles del plan y los límites",
    privacyLink: "Leer el aviso de privacidad completo",
    profileBody:
      "Ambos campos son opcionales. Puedes editar o borrar los datos aceptados más tarde.",
    profileTitle: "¿Cómo puede ayudarte Osfo?",
    readyBody: "Tu Agente Osfo personal está listo. Te preguntará en qué quieres trabajar primero.",
    readyTitle: "Todo listo",
    registered: "Registro completo",
    registrationCompleteBody:
      "Tu registro está completo. Elegiste no conectar la identidad de WhatsApp invitada.",
    registrationCompleteTitle: "Registro completo",
    stopNotice:
      "Antes de iniciar mensajes proactivos, Osfo explica cómo detenerlos. Puedes responder STOP en cualquier momento.",
    storageNotice:
      "Osfo guarda los mensajes y los datos opcionales que aceptes. El diálogo temporal de registro se elimina.",
    whatsAppNotice:
      "WhatsApp procesa los mensajes del canal. Una conexión permite que Osfo dirija un remitente autenticado al usuario correcto.",
    working: "Procesando...",
  },
} as const;

const telegramCopy = {
  en: {
    bindAccept: "Connect this invited Telegram identity to my Osfo account.",
    bindRefuse: "Do not connect this Telegram identity.",
    bindingBody:
      "SMS verification and Telegram identity are separate evidence. This choice is not preselected.",
    bindingTitle: "Telegram binding consent",
    chooseConsent: "Choose whether to connect the invited Telegram identity.",
    continueWhatsApp: "Continue in Telegram",
    enrollmentNotice:
      "Continue in Telegram opens one single-use enrollment link. Only that provider-authenticated message can connect your Telegram identity.",
    linkUnavailableBody: "Request a fresh registration link in Telegram, then try again.",
    pendingBody:
      "Registration is complete, but your Telegram connection is pending. Use the enrollment link to connect your Telegram identity.",
    pendingTitle: "Telegram connection pending",
    registrationCompleteBody:
      "Your registration is complete. You chose not to connect the invited Telegram identity.",
    stopNotice:
      "Osfo requires your consent before it connects Telegram or sends proactive messages.",
    whatsAppNotice:
      "Telegram processes channel messages. A Channel Binding is required so Osfo can route an authenticated sender to the correct user.",
  },
  es: {
    bindAccept: "Conectar esta identidad de Telegram invitada con mi cuenta de Osfo.",
    bindRefuse: "No conectar esta identidad de Telegram.",
    bindingBody:
      "La verificación por SMS y la identidad de Telegram son pruebas separadas. Esta opción no está preseleccionada.",
    bindingTitle: "Consentimiento de conexión de Telegram",
    chooseConsent: "Elige si quieres conectar la identidad de Telegram invitada.",
    continueWhatsApp: "Continuar en Telegram",
    enrollmentNotice:
      "Continuar en Telegram abre un enlace de inscripción de un solo uso. Solo ese mensaje autenticado por el proveedor puede conectar tu identidad.",
    linkUnavailableBody: "Pide un nuevo enlace de registro en Telegram e inténtalo de nuevo.",
    pendingBody:
      "El registro está completo, pero la conexión de Telegram está pendiente. Usa el enlace de inscripción para conectar tu identidad.",
    pendingTitle: "Conexión de Telegram pendiente",
    registrationCompleteBody:
      "Tu registro está completo. Elegiste no conectar la identidad de Telegram invitada.",
    stopNotice:
      "Osfo requiere tu consentimiento antes de conectar Telegram o enviar mensajes proactivos.",
    whatsAppNotice:
      "Telegram procesa los mensajes del canal. Una conexión permite que Osfo dirija un remitente autenticado al usuario correcto.",
  },
} as const;
