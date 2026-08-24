import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type RouterHistory,
  useRouterState,
} from "@tanstack/react-router";

import { AuthenticatedGate } from "./components/authenticated-gate";
import { LoadingScreen } from "./components/loading-screen";
import { NotFoundScreen } from "./components/not-found-screen";
import { SettingsShell } from "./components/settings-shell";
import { parseBillingReturnSearch } from "./lib/billing-return";
import { useDocumentLanguage } from "./lib/document-language";
import { parseLocaleSearch, parseRegistrationSearch } from "./lib/route-locale";

const RootLayout = () => {
  const location = useRouterState({ select: (state) => state.location });
  const localizedRouteOwnsLanguage =
    location.pathname === "/get-started" ||
    location.pathname === "/plans" ||
    location.pathname === "/privacy" ||
    location.pathname.startsWith("/verify/");
  useDocumentLanguage(localizedRouteOwnsLanguage ? null : "en");
  return <Outlet />;
};

const rootRoute = createRootRoute({ component: RootLayout, notFoundComponent: NotFoundScreen });
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
  component: lazyRouteComponent(() => import("./pages/billing-page"), "BillingPage"),
});
const settingsMarketplaceRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "settings/marketplace",
  component: lazyRouteComponent(
    () => import("./pages/settings-marketplace-page"),
    "SettingsMarketplacePage",
  ),
});
const billingRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "billing",
  component: lazyRouteComponent(() => import("./pages/billing-page"), "LegacyBillingPage"),
});
const billingReturnRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "billing/return",
  validateSearch: parseBillingReturnSearch,
  component: lazyRouteComponent(() => import("./pages/billing-page"), "LegacyBillingReturnPage"),
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  loginRoute,
  getStartedRoute,
  channelLinkRoute,
  privacyRoute,
  plansRoute,
  authenticatedRoute.addChildren([
    settingsOverviewRoute,
    settingsRoute.addChildren([
      settingsGeneralRoute,
      settingsChannelsRoute,
      settingsPrivacyRoute,
      settingsProfileRoute,
      settingsBillingRoute,
      settingsMarketplaceRoute,
    ]),
    billingRoute,
    billingReturnRoute,
  ]),
]);

/** Build an Osfo router with browser history or an injected test history. */
export const createAppRouter = ({ history }: { readonly history?: RouterHistory } = {}) =>
  history === undefined
    ? createRouter({
        routeTree,
        defaultPendingComponent: LoadingScreen,
        defaultPendingMs: 100,
        defaultPreload: "intent",
        scrollRestoration: true,
      })
    : createRouter({
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
