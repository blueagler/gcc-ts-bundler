goog.module("gcc.src.AppShell");
const __goog_import_0 = goog.require("gcc.node_modules.react.index");
const React = __goog_import_0.default;
const __goog_import_1 = goog.require("gcc.node_modules._tanstack.react_router.dist.esm.index");
const Link = __goog_import_1.Link;
const Outlet = __goog_import_1.Outlet;
const shellStyles = {
    page: {
        background: "radial-gradient(circle at top left, rgba(255, 220, 173, 0.6), transparent 26%), linear-gradient(160deg, #fffaf2 0%, #eef5ff 48%, #f4fbf2 100%)",
        color: "#17324d",
        minHeight: "100vh"
    },
    header: {
        backdropFilter: "blur(18px)",
        background: "rgba(255, 255, 255, 0.68)",
        borderBottom: "1px solid rgba(23, 50, 77, 0.1)",
        display: "flex",
        gap: 16,
        justifyContent: "space-between",
        padding: "24px 32px",
        position: "sticky",
        top: 0
    },
    nav: {
        display: "flex",
        gap: 12,
        flexWrap: "wrap"
    },
    navLink: {
        border: "1px solid rgba(8, 34, 64, 0.16)",
        borderRadius: 999,
        color: "#17324d",
        display: "inline-flex",
        fontSize: 14,
        fontWeight: 700,
        gap: 8,
        padding: "10px 16px",
        textDecoration: "none"
    },
    navLinkActive: {
        background: "linear-gradient(135deg, #16324f 0%, #245b7a 100%)",
        borderColor: "#16324f",
        boxShadow: "0 16px 30px rgba(22, 50, 79, 0.22)",
        color: "#fffdf7"
    },
    main: {
        padding: "32px clamp(20px, 4vw, 40px) 48px"
    }
};

/**
 * @return {Element}
 */
function NotFoundView() {
    return (React.createElement("section", {
        style: {
            alignItems: "center",
            background: "rgba(255, 252, 247, 0.88)",
            border: "1px solid rgba(23, 50, 77, 0.14)",
            borderRadius: 32,
            display: "flex",
            flexDirection: "column",
            gap: 16,
            minHeight: 320,
            justifyContent: "center",
            padding: 32,
            textAlign: "center"
        }
    }, React.createElement("h2", {
        style: {
            margin: 0
        }
    }, "Route not found"), React.createElement("p", {
        style: {
            margin: 0,
            maxWidth: 520
        }
    }, "This fixture uses full TanStack Router hash navigation. The valid routes are the overview page and the lab page."), React.createElement(Link, {
        style: shellStyles.navLink,
        to: "/"
    }, "Back to Overview")));
}

exports.NotFoundView = NotFoundView;
/**
 * @return {Element}
 */
function AppShell() {
    return (React.createElement("div", {
        style: shellStyles.page
    }, React.createElement("header", {
        style: shellStyles.header
    }, React.createElement("div", null, React.createElement("div", {
        style: {
            fontSize: 30,
            fontWeight: 800
        }
    }, "gcc-ts-bundler React SPA"), React.createElement("div", {
        style: {
            color: "rgba(23, 50, 77, 0.72)",
            marginTop: 8
        }
    }, "React 19 plus full TanStack Router running through the current `ADVANCED` pipeline.")), React.createElement("nav", {
        style: shellStyles.nav
    }, React.createElement(Link, {
        activeProps: {
            style: {
                ...shellStyles.navLink,
                ...shellStyles.navLinkActive
            }
        },
        inactiveProps: {
            style: shellStyles.navLink
        },
        preload: "intent",
        to: "/"
    }, "Overview"), React.createElement(Link, {
        activeProps: {
            style: {
                ...shellStyles.navLink,
                ...shellStyles.navLinkActive
            }
        },
        inactiveProps: {
            style: shellStyles.navLink
        },
        preload: "intent",
        to: "/lab"
    }, "Router Lab"))), React.createElement("main", {
        style: shellStyles.main
    }, React.createElement(Outlet, null))));
}

exports.AppShell = AppShell;