import { PhoneAuthForm } from "./phone-auth-form";

interface AuthScreenProps {
  readonly onAuthenticated: () => void;
}

/** Osfo phone-only sign-in surface. */
export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  return (
    <main className="flex min-h-dvh flex-col bg-[radial-gradient(circle_at_top,oklch(0.96_0.035_250),oklch(0.985_0.006_250)_42%,oklch(0.965_0.008_250))] text-foreground">
      <div className="mx-auto flex w-full max-w-[33rem] flex-1 flex-col items-center justify-center gap-6 px-5 py-10">
        <div className="flex items-center gap-3" aria-label="Osfo">
          <span className="grid size-14 place-items-center rounded-full bg-primary text-2xl font-black text-primary-foreground shadow-lg">
            O
          </span>
          <span className="text-3xl font-black tracking-tight">Osfo</span>
        </div>

        <PhoneAuthForm onAuthenticated={onAuthenticated} />
      </div>
    </main>
  );
}
