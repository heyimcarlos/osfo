import { useState } from "react";

import { AgentIslandHero } from "./agent-island-hero";
import { AgentPanelHeader } from "./agent-panel-header";
import {
  loadAgentControlPreferences,
  saveAgentControlPreferences,
} from "./agent-control-preferences";
import { ConnectedChannels, MessagingSettings } from "./channel-controls";
import { SettingsShortcuts } from "./settings-shortcuts";
import { DocumentBuildSourceUpload } from "./document-build-source-upload";

/** Premium self-contained control panel for one personal Osfo Agent. */
export function OsfoAgentControlPanel() {
  const [preferences, setPreferences] = useState(() =>
    loadAgentControlPreferences(globalThis.localStorage),
  );
  const updatePreferences = (next: typeof preferences) => {
    setPreferences(next);
    saveAgentControlPreferences(globalThis.localStorage, next);
  };

  return (
    <main
      className="min-h-dvh overflow-x-hidden bg-cover bg-center px-4 py-5 text-[#101936] sm:px-8 sm:py-8 lg:grid lg:place-items-center"
      style={{ backgroundImage: "url('/osfo/agent-background.webp')" }}
    >
      <section className="relative mx-auto w-full max-w-[1080px] overflow-hidden rounded-[2rem] border border-white/75 bg-[rgba(245,249,255,0.7)] p-4 shadow-[0_30px_90px_rgba(45,68,110,0.24),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-[24px] sm:p-6 lg:p-7">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-white/35 to-transparent" />
        <AgentPanelHeader status={{ kind: "Active" }} />
        <AgentIslandHero />
        <DocumentBuildSourceUpload />
        <div className="relative z-10 grid gap-3 lg:grid-cols-[0.84fr_1.16fr]">
          <ConnectedChannels
            primaryChannel={preferences.primaryChannel}
            onPrimaryChannelChange={(primaryChannel) =>
              updatePreferences({ ...preferences, primaryChannel })
            }
          />
          <MessagingSettings
            primaryChannel={preferences.primaryChannel}
            onPrimaryChannelChange={(primaryChannel) =>
              updatePreferences({ ...preferences, primaryChannel })
            }
          />
        </div>
        <div className="relative z-10 mt-3">
          <SettingsShortcuts />
        </div>
        <p className="relative z-10 mt-4 text-center text-xs font-medium tracking-wide text-[#70809d] sm:text-sm">
          <span aria-hidden="true">✦ </span>Your agent hub. Always on, always here.
        </p>
      </section>
    </main>
  );
}
