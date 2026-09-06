import { OsfoAgentControlPanel } from "../components/agent-control-panel/osfo-agent-control-panel";
import { useAuthState } from "../auth-state";

/** Route-owned settings overview. */
export function SettingsOverviewPage() {
  const auth = useAuthState();
  if (auth.data === null) return null;
  return <OsfoAgentControlPanel key={auth.data.user.id} />;
}
