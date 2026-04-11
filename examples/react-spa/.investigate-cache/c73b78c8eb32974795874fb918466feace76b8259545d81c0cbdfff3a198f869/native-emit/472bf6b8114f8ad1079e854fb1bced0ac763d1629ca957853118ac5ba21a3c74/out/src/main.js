goog.module("gcc.src.main");
const __goog_import_0 = goog.require("gcc.node_modules.react.index");
const React = __goog_import_0.default;
const StrictMode = React["StrictMode"];

const __goog_import_1 = goog.require("gcc.node_modules.react_dom.client");
const __cjs_import_0 = __goog_import_1.default;
const createRoot = __cjs_import_0["createRoot"];

const __goog_import_2 = goog.require("gcc.node_modules._tanstack.react_router.dist.esm.index");
const RouterProvider = __goog_import_2.RouterProvider;
const __goog_import_3 = goog.require("gcc.src.router");
const router = __goog_import_3.router;
const container = document.getElementById("root");

if (!container) {
    (()=>{
        throw new Error("Missing #root element");
    })();
}

createRoot(container).render(React["createElement"](StrictMode, null, React["createElement"](RouterProvider, {
    router: router
})));
