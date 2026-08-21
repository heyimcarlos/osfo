import { Link } from "@tanstack/react-router";

import { useDocumentLanguage } from "../lib/document-language";

type Locale = "en" | "es";

const planRows = {
  en: [
    ["Accepted messages", "30 per 30-day period", "300 per billing period"],
    ["Managed model steps per request", "6", "12"],
    ["File uploads", "10 files, 10 MB each", "100 files, 25 MB each"],
    ["Generated documents", "Not included", "10 per period"],
    ["Cited research reports", "Not included", "5 per period"],
    ["Reminders", "1 active", "25 active"],
  ],
  es: [
    ["Mensajes aceptados", "30 por cada periodo de 30 días", "300 por periodo de facturación"],
    ["Pasos de modelo por solicitud", "6", "12"],
    ["Archivos subidos", "10 archivos de 10 MB", "100 archivos de 25 MB"],
    ["Documentos generados", "No incluido", "10 por periodo"],
    ["Informes de investigación con citas", "No incluido", "5 por periodo"],
    ["Recordatorios", "1 activo", "25 activos"],
  ],
} as const;

/** Public privacy notice linked before Phone Verification. */
export function PrivacyNotice({ locale = publicLocale() }: { readonly locale?: Locale }) {
  if (locale === "es") {
    return (
      <InformationPage locale="es" title="Aviso de privacidad">
        <p>
          Osfo usa IA para procesar los datos de configuración, los mensajes y los archivos para
          responder a tus solicitudes. No envíes información que no quieras que Osfo procese.
        </p>
        <h2>Qué guarda Osfo</h2>
        <p>
          Osfo guarda los datos verificados de tu cuenta, los datos de perfil que aceptes, los
          mensajes, los archivos, la configuración, el uso del plan y los registros técnicos
          necesarios para ofrecer y proteger el servicio. Las invitaciones para conectar un canal no
          contienen la dirección externa ni datos de la cuenta.
        </p>
        <h2>WhatsApp y proveedores de servicio</h2>
        <p>
          WhatsApp procesa los mensajes del canal. Osfo también usa proveedores de infraestructura,
          IA, memoria, almacenamiento y SMS. Una conexión de canal dirige un remitente autenticado
          al usuario de Osfo correcto.
        </p>
        <h2>Tus opciones y derechos</h2>
        <p>
          Puedes editar o borrar los datos de perfil aceptados. Puedes solicitar acceso, corrección,
          exportación o eliminación de tus datos, y puedes revocar una conexión. Antes de los
          mensajes proactivos, Osfo explica cómo detenerlos. Puedes responder STOP en cualquier
          momento.
        </p>
        <h2>Retención y seguridad</h2>
        <p>
          El historial se guarda hasta que lo elimines o borres tu cuenta. Osfo conserva pruebas
          limitadas de seguridad, facturación y eliminación cuando es obligatorio. El acceso se
          limita a los sistemas y personas que operan, protegen y mantienen el servicio.
        </p>
        <p>
          Puedes enviar solicitudes y preguntas de privacidad al soporte de Osfo. Este aviso se
          aplica al servicio inicial y mostrará una fecha de revisión cuando cambie.
        </p>
      </InformationPage>
    );
  }

  return (
    <InformationPage locale="en" title="Privacy notice">
      <p>
        Osfo uses AI to process setup details, messages, and files so it can answer requests. Do not
        send information that you do not want Osfo to process.
      </p>
      <h2>What Osfo stores</h2>
      <p>
        Osfo stores your verified account details, accepted profile facts, messages, files, account
        settings, plan use, and the technical records needed to deliver and secure the service.
        Channel Link invitations contain no external address or account details.
      </p>
      <h2>WhatsApp and service providers</h2>
      <p>
        WhatsApp processes channel messages. Osfo also uses managed infrastructure, AI, memory,
        storage, and SMS providers to operate the service. A Channel Link routes an authenticated
        messaging address to the correct Osfo user.
      </p>
      <h2>Your choices and rights</h2>
      <p>
        You can edit or erase accepted profile facts. You can request access, correction, export, or
        deletion of your data. You can revoke a connection. Before proactive WhatsApp messages
        begin, Osfo explains how to stop them. You can reply STOP at any time.
      </p>
      <h2>Retention and safety</h2>
      <p>
        Conversation history is retained until you delete it or your account. Osfo keeps limited
        security, billing, and deletion evidence when it must do so. Access is limited to the
        systems and people that need it to operate, secure, and support the service.
      </p>
      <p>
        Privacy requests and questions can be sent through Osfo support. This notice applies to the
        launch service and will show a revision date when its terms change.
      </p>
    </InformationPage>
  );
}

/** Public launch Plan details linked from registration. */
export function PlanDetails({ locale = publicLocale() }: { readonly locale?: Locale }) {
  const spanish = locale === "es";
  return (
    <InformationPage locale={locale} title={spanish ? "Planes y límites" : "Plans and allowances"}>
      <p>
        {spanish
          ? "Free cuesta CA$0. Adventurer cuesta CA$25 al mes, más impuestos. Al inicio no hay plan anual, prueba, cargos por exceso, complementos de uso ni selección de modelo."
          : "Free costs CA$0. Adventurer costs CA$25 each month, plus tax. There is no annual plan, trial, overage charge, usage add-on, or user-selected model at launch."}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
          <thead>
            <tr>
              <th className="border-2 p-3">{spanish ? "Límite" : "Allowance"}</th>
              <th className="border-2 p-3">Free</th>
              <th className="border-2 p-3">Adventurer</th>
            </tr>
          </thead>
          <tbody>
            {planRows[locale].map(([name, free, adventurer]) => (
              <tr key={name}>
                <th className="border-2 p-3 font-bold">{name}</th>
                <td className="border-2 p-3">{free}</td>
                <td className="border-2 p-3">{adventurer}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        {spanish
          ? "Free incluye conversación administrada, uso limitado de memoria, análisis de archivos compatibles y recordatorios únicos. Adventurer añade límites mayores, generación de documentos, investigación con citas, Gmail, recordatorios recurrentes, Workflows y GM Summon. Los límites no se acumulan. Las acciones de seguridad, cuenta, facturación, cancelación, eliminación y derechos de datos siguen disponibles después de agotar el uso normal."
          : "Free includes managed conversation, bounded memory use, supported file analysis, and one-time reminders. Adventurer adds higher limits, document generation, cited research, Gmail, recurring reminders, Workflows, and GM Summon. Allowances do not roll over. Safety, account, billing, cancellation, deletion, and data-right actions remain available after ordinary use is exhausted."}
      </p>
    </InformationPage>
  );
}

const InformationPage = ({
  children,
  locale,
  title,
}: {
  readonly children: React.ReactNode;
  readonly locale: Locale;
  readonly title: string;
}) => {
  useDocumentLanguage(locale);

  return (
    <main className="min-h-dvh bg-background px-5 py-10 text-foreground">
      <article className="mx-auto max-w-3xl space-y-5 [&_h2]:pt-3 [&_h2]:text-2xl [&_h2]:font-black [&_h2]:uppercase [&_p]:leading-relaxed">
        <Link className="font-bold underline" search={{ lang: locale }} to="/get-started">
          {locale === "es" ? "Volver a la configuración" : "Back to setup"}
        </Link>
        <h1 className="text-4xl font-black uppercase sm:text-6xl">{title}</h1>
        {children}
      </article>
    </main>
  );
};

const publicLocale = (): Locale =>
  new URLSearchParams(globalThis.location?.search).get("lang") === "es" ? "es" : "en";
