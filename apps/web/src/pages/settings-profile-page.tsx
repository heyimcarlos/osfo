import { Button } from "@osfo/ui/components/button";
import { Input } from "@osfo/ui/components/input";
import { Label } from "@osfo/ui/components/label";
import { Link } from "@tanstack/react-router";
import { KeyRound, UserRound } from "lucide-react";
import { useState } from "react";

import { useAuthState } from "../auth-state";
import { setLoginCredentials } from "../lib/auth-client";
import { presentUserLabel } from "../lib/user-label";

const accountLinkClassName =
  "flex min-h-11 items-center rounded-xl px-3 text-sm font-medium text-[#135fdd] hover:bg-[#edf4ff] focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:outline-none";

/** Account identity and supported sign-in controls. */
export function SettingsProfilePage() {
  const session = useAuthState();
  const user = session.data?.user;
  const userLabel = user === undefined ? "Osfo User" : presentUserLabel(user);
  const phoneNumber = user?.phoneNumber ?? "Not added";

  return (
    <div className="grid gap-7 lg:grid-cols-[minmax(0,1.35fr)_minmax(250px,0.8fr)]">
      <section aria-labelledby="profile-information-title">
        <div className="mb-5 flex items-center gap-3">
          <span className="grid size-20 place-items-center rounded-full border-4 border-white bg-[#eaf1fb] text-[#61779c] shadow-sm">
            <UserRound aria-hidden="true" className="size-10" />
          </span>
          <div>
            <h2 className="text-xl font-bold" id="profile-information-title">
              {userLabel}
            </h2>
            <p className="text-sm text-[#687896]">Your Osfo account</p>
          </div>
        </div>

        <dl className="grid gap-3 rounded-2xl border border-white/80 bg-white/68 p-4">
          <AccountFact label="Phone" value={phoneNumber} />
        </dl>
      </section>

      <aside className="grid content-start gap-5">
        <section className="rounded-[1.35rem] border border-white/85 bg-white/68 p-5 shadow-[0_12px_32px_rgba(70,103,145,0.1)]">
          <h2 className="font-bold">Account</h2>
          <div className="mt-4 grid gap-2">
            <Link className={accountLinkClassName} to="/settings/billing">
              Manage plan and payments
            </Link>
            <Link className={accountLinkClassName} to="/settings/channels">
              Manage messaging channels
            </Link>
            <Link className={accountLinkClassName} to="/settings/privacy">
              Privacy and account deletion
            </Link>
          </div>
        </section>
        <section className="rounded-[1.35rem] border border-white/85 bg-white/68 p-4 shadow-[0_12px_32px_rgba(70,103,145,0.1)]">
          <h2 className="px-1 font-bold">Security</h2>
          <div className="mt-3 grid gap-2">
            <PasswordSetup />
          </div>
        </section>
      </aside>
    </div>
  );
}

function PasswordSetup() {
  const [confirmation, setConfirmation] = useState("");
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string>();
  const [password, setPassword] = useState("");

  const submit = () => {
    if (password !== confirmation) {
      setMessage("The passwords do not match.");
      return Promise.resolve();
    }
    setIsSubmitting(true);
    setMessage(undefined);
    return setLoginCredentials(email, password).then((result) => {
      setIsSubmitting(false);
      if (result.error !== null) {
        setMessage(result.error);
        return;
      }
      setConfirmation("");
      setEmail("");
      setPassword("");
      setMessage("Sign-in credentials added. You can now use email and password.");
    });
  };

  return (
    <form
      className="grid gap-3 rounded-xl border border-[#d6e1ef] bg-white/65 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-full bg-[#e7f1ff] text-[#2f7df4]">
          <KeyRound aria-hidden="true" className="size-5" />
        </span>
        <div>
          <h3 className="font-semibold">Add sign-in credentials</h3>
          <p className="text-xs text-[#687896]">
            Phone verification remains your account identity.
          </p>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="login-email">Email</Label>
        <Input
          autoComplete="email"
          id="login-email"
          required
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value.trim())}
        />
        <Label htmlFor="new-login-password">New password</Label>
        <Input
          autoComplete="new-password"
          id="new-login-password"
          minLength={8}
          required
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Label htmlFor="confirm-login-password">Confirm password</Label>
        <Input
          autoComplete="new-password"
          id="confirm-login-password"
          minLength={8}
          required
          type="password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </div>
      {message === undefined ? null : (
        <p className="text-xs font-medium text-[#44556f]" role="status">
          {message}
        </p>
      )}
      <Button disabled={isSubmitting} type="submit">
        {isSubmitting ? "Saving..." : "Add email and password"}
      </Button>
    </form>
  );
}

function AccountFact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-xs text-[#687896]">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
