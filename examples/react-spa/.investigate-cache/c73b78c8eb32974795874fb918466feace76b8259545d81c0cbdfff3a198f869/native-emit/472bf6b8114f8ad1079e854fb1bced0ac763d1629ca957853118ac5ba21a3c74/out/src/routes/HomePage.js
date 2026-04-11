goog.module("gcc.src.routes.HomePage");
const __goog_import_0 = goog.require("gcc.node_modules.react.index");
const React = __goog_import_0.default;
const useState = React["useState"];

const __goog_import_1 = goog.require("gcc.node_modules._tanstack.react_router.dist.esm.index");
const Link = __goog_import_1.Link;
const panelStyle = {
    background: "rgba(255, 252, 247, 0.82)",
    border: "1px solid rgba(23, 50, 77, 0.08)",
    borderRadius: 28,
    boxShadow: "0 24px 60px rgba(29, 56, 82, 0.12)",
    padding: 28
};

/**
 * @return {Element}
 */
function HomePage() {
    const [count, setCount] = useState(0);
    return (React["createElement"]("div", {
        style: {
            display: "grid",
            gap: 24
        }
    }, React["createElement"]("section", {
        style: panelStyle
    }, React["createElement"]("div", {
        style: {
            display: "grid",
            gap: 24,
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))"
        }
    }, React["createElement"]("div", {
        style: {
            display: "grid",
            gap: 18
        }
    }, React["createElement"]("div", {
        style: {
            alignSelf: "start",
            background: "#dce8ff",
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 800,
            padding: "8px 14px",
            width: "fit-content"
        }
    }, "React 19 runtime"), React["createElement"]("h1", {
        style: {
            fontSize: "clamp(2.25rem, 4vw, 4rem)",
            lineHeight: 1,
            margin: 0
        }
    }, "Full TanStack Router in `ADVANCED`"), React["createElement"]("p", {
        style: {
            fontSize: 17,
            lineHeight: 1.6,
            margin: 0,
            maxWidth: 620
        }
    }, "This fixture keeps the runtime target focused: React 19, `react-dom`, and the full `@tanstack/react-router` provider and route tree, with no UI library-specific behavior hiding compiler issues."), React["createElement"]("div", {
        style: {
            display: "flex",
            flexWrap: "wrap",
            gap: 12
        }
    }, React["createElement"]("button", {
        onClick: ()=>setCount((current)=>current + 1),
        style: primaryButtonStyle,
        type: "button"
    }, "Count: ", count), React["createElement"](Link, {
        preload: "intent",
        style: secondaryLinkStyle,
        to: "/lab"
    }, "Open router lab"))), React["createElement"]("div", {
        style: {
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))"
        }
    }, [
        [
            "Routes",
            "2"
        ],
        [
            "Provider",
            "RouterProvider"
        ],
        [
            "Compiler",
            "ADVANCED"
        ],
        [
            "Packages",
            "npm"
        ]
    ].map(([label, value])=>(React["createElement"]("div", {
            "key": label,
            style: {
                background: "rgba(255,255,255,0.72)",
                borderRadius: 22,
                padding: 18
            }
        }, React["createElement"]("div", {
            style: {
                color: "rgba(23, 50, 77, 0.72)",
                fontSize: 13,
                fontWeight: 700
            }
        }, label), React["createElement"]("div", {
            style: {
                fontSize: 22,
                fontWeight: 800,
                marginTop: 8
            }
        }, value))))))), React["createElement"]("section", {
        style: {
            ...panelStyle,
            background: "linear-gradient(135deg, rgba(22, 50, 79, 0.98), rgba(47, 113, 151, 0.92))",
            color: "#fffdf7"
        }
    }, React["createElement"]("div", {
        style: {
            display: "grid",
            gap: 18
        }
    }, React["createElement"]("div", {
        style: {
            letterSpacing: "0.14em",
            opacity: 0.7,
            textTransform: "uppercase"
        }
    }, "Why this demo"), React["createElement"]("div", {
        style: {
            fontSize: 28,
            fontWeight: 800,
            lineHeight: 1.1
        }
    }, "No Ant Design, no Lit-specific target, no safety blanket."), React["createElement"]("p", {
        style: {
            fontSize: 16,
            lineHeight: 1.65,
            margin: 0,
            maxWidth: 720,
            opacity: 0.86
        }
    }, "The point of this example is to prove that a modern routed React app can survive the package pipeline under aggressive optimization without relying on package-name-specific rules or broad property preservation.")))));
}

exports.HomePage = HomePage;
const primaryButtonStyle = {
    background: "linear-gradient(135deg, #16324f 0%, #245b7a 100%)",
    border: "none",
    borderRadius: 999,
    boxShadow: "0 16px 30px rgba(22, 50, 79, 0.22)",
    color: "#fffdf7",
    cursor: "pointer",
    fontSize: 15,
    fontWeight: 800,
    padding: "12px 18px"
};

const secondaryLinkStyle = {
    border: "1px solid rgba(8, 34, 64, 0.16)",
    borderRadius: 999,
    color: "#17324d",
    display: "inline-flex",
    fontSize: 15,
    fontWeight: 700,
    padding: "12px 18px",
    textDecoration: "none"
};
