import { KeyRound, ShieldCheck, UserRound } from "lucide-react";

import { useAuthState } from "../auth-state";
import { presentUserLabel } from "../lib/user-label";

const fieldClassName =
  "min-h-12 w-full rounded-xl border border-white/85 bg-white/68 px-3 text-sm text-[#26334f] outline-none";

/** Route-owned authenticated profile preview. */
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
            <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-[#dff7e9] px-3 py-1 text-xs font-semibold text-[#267b51]">
              <span aria-hidden="true" className="size-2 rounded-full bg-[#28b66f]" />
              Agent Active
            </span>
          </div>
        </div>

        <div className="grid gap-3">
          <ProfileField label="Full name" value={userLabel} />
          <ProfileField label="Username" value="@osfo-user" />
          <ProfileField label="Email" value="Not added" />
          <ProfileField label="Phone" value={phoneNumber} />
          <label className="grid gap-1 text-xs font-medium text-[#607393]">
            Bio
            <textarea
              className={`${fieldClassName} min-h-20 resize-none py-3`}
              readOnly
              value="Your private personal agent, ready when you are."
            />
          </label>
          <button
            className="min-h-12 w-fit cursor-not-allowed rounded-xl bg-[#2f7df4] px-6 font-semibold text-white opacity-65"
            disabled
            type="button"
          >
            Save changes, coming soon
          </button>
        </div>
      </section>

      <aside className="grid content-start gap-5">
        <section className="rounded-[1.35rem] border border-white/85 bg-white/68 p-5 shadow-[0_12px_32px_rgba(70,103,145,0.1)]">
          <h2 className="font-bold">Account</h2>
          <dl className="mt-4 grid gap-5 text-sm">
            <AccountFact label="Status" value="Active" />
            <AccountFact label="Plan" value="Manage in Billing" />
            <AccountFact label="Primary channel" value="WhatsApp" />
          </dl>
        </section>
        <section className="rounded-[1.35rem] border border-white/85 bg-white/68 p-4 shadow-[0_12px_32px_rgba(70,103,145,0.1)]">
          <h2 className="px-1 font-bold">Security</h2>
          <div className="mt-3 grid gap-2">
            <SecurityRow icon={KeyRound} label="Change password" />
            <SecurityRow icon={ShieldCheck} label="Two-factor authentication" />
          </div>
        </section>
      </aside>
    </div>
  );
}

function ProfileField({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <label className="grid gap-1 text-xs font-medium text-[#607393]">
      {label}
      <input className={fieldClassName} readOnly value={value} />
    </label>
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

function SecurityRow({
  icon: Icon,
  label,
}: {
  readonly icon: typeof KeyRound;
  readonly label: string;
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 rounded-xl border border-[#d6e1ef] bg-white/65 px-3">
      <span className="grid size-9 place-items-center rounded-full bg-[#e7f1ff] text-[#2f7df4]">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <span className="min-w-0 flex-1 font-semibold">{label}</span>
      <span className="text-[10px] text-[#687896]">Coming soon</span>
    </div>
  );
}
