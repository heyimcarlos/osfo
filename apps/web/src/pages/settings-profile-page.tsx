import { useAuthState } from "../auth-state";
import { presentUserLabel } from "../lib/user-label";

/** Route-owned authenticated profile summary. */
export function SettingsProfilePage() {
  const session = useAuthState();
  const userLabel = session.data === null ? "Osfo User" : presentUserLabel(session.data.user);
  return (
    <div>
      <p className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">
        Identity
      </p>
      <h2 className="mt-2 text-4xl font-black uppercase md:text-6xl">Profile</h2>
      <dl className="mt-8 max-w-xl border-2">
        <div className="border-b-2 p-5">
          <dt className="text-xs font-black uppercase tracking-[0.16em] text-muted-foreground">
            Signed in as
          </dt>
          <dd className="mt-2 text-xl font-black">{userLabel}</dd>
        </div>
        <div className="p-5">
          <dt className="text-xs font-black uppercase tracking-[0.16em] text-muted-foreground">
            Profile changes
          </dt>
          <dd className="mt-2 text-muted-foreground">
            Contact support to change verified identity details.
          </dd>
        </div>
      </dl>
    </div>
  );
}
