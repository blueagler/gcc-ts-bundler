goog.module("gcc.src.router");
const __goog_import_0 = goog.require("gcc.node_modules._tanstack.react_router.dist.esm.index");
const createHashHistory = __goog_import_0.createHashHistory;
const createRootRoute = __goog_import_0.createRootRoute;
const createRoute = __goog_import_0.createRoute;
const createRouter = __goog_import_0.createRouter;
const __goog_import_1 = goog.require("gcc.src.AppShell");
const AppShell = __goog_import_1.AppShell;
const NotFoundView = __goog_import_1.NotFoundView;
const __goog_import_2 = goog.require("gcc.src.routes.HomePage");
const HomePage = __goog_import_2.HomePage;
const __goog_import_3 = goog.require("gcc.src.routes.LabPage");
const LabPage = __goog_import_3.LabPage;
const rootRoute = createRootRoute({
    component: AppShell,
    notFoundComponent: NotFoundView
});

const homeRoute = createRoute({
    component: HomePage,
    getParentRoute: ()=>rootRoute,
    path: "/"
});

const labRoute = createRoute({
    component: LabPage,
    getParentRoute: ()=>rootRoute,
    path: "/lab"
});

const routeTree = rootRoute.addChildren([
    homeRoute,
    labRoute
]);

const router = createRouter({
    defaultPreload: "intent",
    history: createHashHistory(),
    routeTree
});

exports.router = router;