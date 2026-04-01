import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AppShell, NotFoundView } from "./AppShell";
import { HomePage } from "./routes/HomePage";
import { LabPage } from "./routes/LabPage";

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: NotFoundView,
});

const homeRoute = createRoute({
  component: HomePage,
  getParentRoute: () => rootRoute,
  path: "/",
});

const labRoute = createRoute({
  component: LabPage,
  getParentRoute: () => rootRoute,
  path: "/lab",
});

const routeTree = rootRoute.addChildren([homeRoute, labRoute]);

export const router = createRouter({
  defaultPreload: "intent",
  history: createHashHistory(),
  routeTree,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
