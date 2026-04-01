import React from "react";
import { Link, Outlet } from "@tanstack/react-router";

const shellStyles = {
  page: {
    background:
      "radial-gradient(circle at top left, rgba(255, 220, 173, 0.6), transparent 26%), linear-gradient(160deg, #fffaf2 0%, #eef5ff 48%, #f4fbf2 100%)",
    color: "#17324d",
    minHeight: "100vh",
  },
  header: {
    backdropFilter: "blur(18px)",
    background: "rgba(255, 255, 255, 0.68)",
    borderBottom: "1px solid rgba(23, 50, 77, 0.1)",
    display: "flex",
    gap: 16,
    justifyContent: "space-between",
    padding: "24px 32px",
    position: "sticky" as const,
    top: 0,
  },
  nav: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap" as const,
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
    textDecoration: "none",
  },
  navLinkActive: {
    background: "linear-gradient(135deg, #16324f 0%, #245b7a 100%)",
    borderColor: "#16324f",
    boxShadow: "0 16px 30px rgba(22, 50, 79, 0.22)",
    color: "#fffdf7",
  },
  main: {
    padding: "32px clamp(20px, 4vw, 40px) 48px",
  },
};

export function NotFoundView() {
  return (
    <section
      style={{
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
        textAlign: "center",
      }}
    >
      <h2 style={{ margin: 0 }}>Route not found</h2>
      <p style={{ margin: 0, maxWidth: 520 }}>
        This fixture uses full TanStack Router hash navigation. The valid routes are the overview
        page and the lab page.
      </p>
      <Link style={shellStyles.navLink} to="/">
        Back to Overview
      </Link>
    </section>
  );
}

export function AppShell() {
  return (
    <div style={shellStyles.page}>
      <header style={shellStyles.header}>
        <div>
          <div style={{ fontSize: 30, fontWeight: 800 }}>gcc-ts-bundler React SPA</div>
          <div style={{ color: "rgba(23, 50, 77, 0.72)", marginTop: 8 }}>
            React 19 plus full TanStack Router running through the current `ADVANCED` pipeline.
          </div>
        </div>

        <nav style={shellStyles.nav}>
          <Link
            activeProps={{ style: { ...shellStyles.navLink, ...shellStyles.navLinkActive } }}
            inactiveProps={{ style: shellStyles.navLink }}
            preload="intent"
            to="/"
          >
            Overview
          </Link>
          <Link
            activeProps={{ style: { ...shellStyles.navLink, ...shellStyles.navLinkActive } }}
            inactiveProps={{ style: shellStyles.navLink }}
            preload="intent"
            to="/lab"
          >
            Router Lab
          </Link>
        </nav>
      </header>

      <main style={shellStyles.main}>
        <Outlet />
      </main>
    </div>
  );
}
