import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

import {
  clearBrowserAccountDeletionReplay,
  type AccountDeletionReplay,
  type AccountDeletionReplayRequest,
  type BrowserAccountDeletionReplayCapture,
} from "./lib/account-deletion-replay";

interface AccountDeletionReplayState {
  readonly access: BrowserAccountDeletionReplayCapture["access"];
  readonly clear: () => void;
  readonly complete: () => void;
  readonly replay: AccountDeletionReplay;
  readonly retain: (request: AccountDeletionReplayRequest) => void;
}

const Context = createContext<AccountDeletionReplayState | null>(null);

/** Own one browser-storage lookup and its decoded replay for this mounted application. */
export function AccountDeletionReplayStateProvider({
  children,
  initial,
}: {
  readonly children: ReactNode;
  readonly initial: BrowserAccountDeletionReplayCapture;
}) {
  const [replay, setReplay] = useState(initial.replay);
  const retain = useCallback(
    (request: AccountDeletionReplayRequest) => setReplay({ request, status: "available" }),
    [],
  );
  const clear = useCallback(() => {
    const outcome = clearBrowserAccountDeletionReplay(initial.access);
    setReplay(outcome === "cleared" ? { status: "missing" } : { status: "unavailable" });
  }, [initial]);
  const complete = useCallback(() => {
    clearBrowserAccountDeletionReplay(initial.access);
    setReplay({ status: "missing" });
  }, [initial]);
  const value = useMemo(
    () => ({ access: initial.access, clear, complete, replay, retain }),
    [clear, complete, initial, replay, retain],
  );

  return <Context value={value}>{children}</Context>;
}

/** Consume the page-lifetime replay capture owned by the root route. */
export function useAccountDeletionReplayState(): AccountDeletionReplayState {
  const state = useContext(Context);
  if (state === null) throw new Error("AccountDeletionReplayStateProvider is missing");
  return state;
}
