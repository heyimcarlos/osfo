import { documentDownloadPath } from "@osfo/api/document-download";
import { Option, Schema } from "effect";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  type RouterHistory,
  useRouterState,
} from "@tanstack/react-router";

import { AccountDeletionReplayStateProvider } from "./account-deletion-replay-state";
import { AuthenticatedGate } from "./components/authenticated-gate";
import { LoadingScreen } from "./components/loading-screen";
import { NotFoundScreen } from "./components/not-found-screen";
import { SettingsShell } from "./components/settings-shell";
import { billingReturnQuery, parseBillingReturnSearchString } from "./lib/billing-return";
import {
  captureBrowserAccountDeletionReplay,
  type BrowserAccountDeletionReplayCapture,
} from "./lib/account-deletion-replay";
import { useDocumentLanguage } from "./lib/document-language";
import { parseLocaleSearch, parseRegistrationSearch } from "./lib/route-locale";

const RootLayout = () => {
  const { accountDeletionReplay } = rootRoute.useRouteContext();
  const location = useRouterState({ select: (state) => state.location });
  const localizedRouteOwnsLanguage =
    location.pathname === "/get-started" ||
    location.pathname === "/plans" ||
    location.pathname === "/privacy" ||
    location.pathname.startsWith("/verify/");
  useDocumentLanguage(localizedRouteOwnsLanguage ? null : "en");
  return (
    <AccountDeletionReplayStateProvider initial={accountDeletionReplay}>
      <Outlet />
    </AccountDeletionReplayStateProvider>
  );
};

interface RouterContext {
  readonly accountDeletionReplay: BrowserAccountDeletionReplayCapture;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFoundScreen,
});
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./pages/home-page"), "HomePage"),
});
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "login",
  component: lazyRouteComponent(() => import("./pages/login-page"), "LoginPage"),
});
const accountDeletionRecoveryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "account-deletion/recovery",
  component: lazyRouteComponent(
    () => import("./pages/account-deletion-recovery-page"),
    "AccountDeletionRecoveryPage",
  ),
});
const getStartedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "get-started",
  validateSearch: parseRegistrationSearch,
  component: lazyRouteComponent(() => import("./pages/get-started-page"), "GetStartedRoute"),
});
const channelLinkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "verify/$token",
  component: lazyRouteComponent(() => import("./pages/channel-link-page"), "ChannelLinkRoute"),
});
const privacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "privacy",
  validateSearch: parseLocaleSearch,
  component: lazyRouteComponent(() => import("./pages/privacy-notice-page"), "PrivacyNoticePage"),
});
const plansRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "plans",
  validateSearch: parseLocaleSearch,
  component: lazyRouteComponent(() => import("./pages/plan-details-page"), "PlanDetailsPage"),
});
const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authenticated",
  component: AuthenticatedGate,
});
const documentDownloadRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: documentDownloadPath,
  validateSearch: (search: { readonly contentId?: unknown }) => ({
    contentId: Option.getOrUndefined(
      Schema.decodeUnknownOption(
        Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
      )(search.contentId),
    ),
  }),
  component: lazyRouteComponent(
    () => import("./pages/document-download-page"),
    "DocumentDownloadPage",
  ),
});
const settingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  id: "settingsDetails",
  component: SettingsShell,
});
const settingsOverviewRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "settings",
  component: lazyRouteComponent(
    () => import("./pages/settings-overview-page"),
    "SettingsOverviewPage",
  ),
});
const settingsGeneralRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "settings/general",
  component: lazyRouteComponent(
    () => import("./pages/settings-general-page"),
    "SettingsGeneralPage",
  ),
});
const settingsChannelsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "settings/channels",
  component: lazyRouteComponent(
    () => import("./pages/settings-channels-page"),
    "SettingsChannelsPage",
  ),
});
const settingsIntegrationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "settings/integrations",
  component: lazyRouteComponent(
    () => import("./pages/settings-integrations-page"),
    "SettingsIntegrationsPage",
  ),
});
const settingsRemindersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "settings/reminders",
  component: lazyRouteComponent(
    () => import("./pages/settings-reminders-page"),
    "SettingsRemindersPage",
  ),
});
const settingsPrivacyRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "settings/privacy",
  component: lazyRouteComponent(
    () => import("./pages/settings-privacy-page"),
    "SettingsPrivacyPage",
  ),
});
const settingsProfileRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "settings/profile",
  component: lazyRouteComponent(
    () => import("./pages/settings-profile-page"),
    "SettingsProfilePage",
  ),
});
const settingsBillingRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "settings/billing",
  component: lazyRouteComponent(
    () => import("./pages/settings-billing-page"),
    "SettingsBillingPage",
  ),
});
const settingsMarketplaceRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "settings/marketplace",
  beforeLoad: () => {
    throw redirect({ replace: true, search: {}, to: "/settings/integrations" });
  },
});
const settingsSkillsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "settings/skills",
  component: lazyRouteComponent(() => import("./pages/settings-skills-page"), "SettingsSkillsPage"),
});
const legacyBillingRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "billing",
  beforeLoad: () => {
    throw redirect({ replace: true, search: {}, to: "/settings/billing" });
  },
});
const legacyBillingReturnRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "billing/return",
  beforeLoad: ({ location }) => {
    throw redirect({
      replace: true,
      search: billingReturnQuery(parseBillingReturnSearchString(location.searchStr)),
      to: "/settings/billing",
    });
  },
});
const routeTree = rootRoute.addChildren([
  homeRoute,
  loginRoute,
  accountDeletionRecoveryRoute,
  getStartedRoute,
  channelLinkRoute,
  privacyRoute,
  plansRoute,
  authenticatedRoute.addChildren([
    documentDownloadRoute,
    settingsOverviewRoute,
    settingsRoute.addChildren([
      settingsGeneralRoute,
      settingsChannelsRoute,
      settingsIntegrationsRoute,
      settingsRemindersRoute,
      settingsPrivacyRoute,
      settingsProfileRoute,
      settingsBillingRoute,
      settingsMarketplaceRoute,
      settingsSkillsRoute,
    ]),
    legacyBillingRoute,
    legacyBillingReturnRoute,
  ]),
]);

/** Build an Osfo router with browser history or an injected test history. */
export const createAppRouter = ({ history }: { readonly history?: RouterHistory } = {}) =>
  history === undefined
    ? createRouter({
        context: { accountDeletionReplay: captureBrowserAccountDeletionReplay() },
        routeTree,
        defaultPendingComponent: LoadingScreen,
        defaultPendingMs: 100,
        defaultPreload: "intent",
        scrollRestoration: true,
      })
    : createRouter({
        context: { accountDeletionReplay: captureBrowserAccountDeletionReplay() },
        routeTree,
        history,
        defaultPendingComponent: LoadingScreen,
        defaultPendingMs: 100,
        defaultPreload: "intent",
        scrollRestoration: true,
      });

/** Browser router singleton. */
export const appRouter = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    readonly router: typeof appRouter;
  }
}
