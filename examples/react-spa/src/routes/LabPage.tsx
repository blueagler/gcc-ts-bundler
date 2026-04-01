import React, { useState } from "react";
import { Link } from "@tanstack/react-router";

const panelStyle = {
  background: "rgba(255, 252, 247, 0.82)",
  border: "1px solid rgba(23, 50, 77, 0.08)",
  borderRadius: 28,
  boxShadow: "0 24px 60px rgba(29, 56, 82, 0.12)",
  padding: 28,
};

const navLinkStyle = {
  border: "1px solid rgba(8, 34, 64, 0.16)",
  borderRadius: 999,
  color: "#17324d",
  display: "inline-flex",
  fontSize: 15,
  fontWeight: 700,
  padding: "12px 18px",
  textDecoration: "none",
};

export function LabPage() {
  const [notes, setNotes] = useState("Router state is alive.");
  const [selectedItem, setSelectedItem] = useState("overview");

  return (
    <div
      style={{
        display: "grid",
        gap: 24,
        gridTemplateColumns: "minmax(0, 2fr) minmax(280px, 1fr)",
      }}
    >
      <section style={panelStyle}>
        <div style={{ display: "grid", gap: 16 }}>
          <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between" }}>
            <div>
              <h2 style={{ margin: 0 }}>Router lab</h2>
              <p style={{ color: "rgba(23, 50, 77, 0.72)", margin: "8px 0 0" }}>
                A second route with local state, selection, and a controlled input.
              </p>
            </div>
            <Link preload="intent" style={navLinkStyle} to="/">
              Back to overview
            </Link>
          </div>

          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            {["overview", "details", "history"].map((item) => (
              <button
                key={item}
                onClick={() => setSelectedItem(item)}
                style={{
                  background: selectedItem === item ? "#16324f" : "rgba(255,255,255,0.72)",
                  border: "1px solid rgba(8, 34, 64, 0.16)",
                  borderRadius: 20,
                  color: selectedItem === item ? "#fffdf7" : "#17324d",
                  cursor: "pointer",
                  fontWeight: 700,
                  padding: "14px 12px",
                  textTransform: "capitalize",
                }}
                type="button"
              >
                {item}
              </button>
            ))}
          </div>

          <label style={{ display: "grid", gap: 8 }}>
            <span style={{ fontWeight: 700 }}>Lab notes</span>
            <textarea
              onChange={(event) => setNotes(event.currentTarget.value)}
              style={{
                background: "rgba(255,255,255,0.9)",
                border: "1px solid rgba(8, 34, 64, 0.16)",
                borderRadius: 18,
                color: "#17324d",
                font: "inherit",
                minHeight: 160,
                padding: 16,
                resize: "vertical",
              }}
              value={notes}
            />
          </label>
        </div>
      </section>

      <aside
        style={{
          ...panelStyle,
          background: "linear-gradient(180deg, rgba(22, 50, 79, 0.96), rgba(36, 91, 122, 0.9))",
          color: "#fffdf7",
        }}
      >
        <div style={{ display: "grid", gap: 14 }}>
          <div
            style={{
              alignSelf: "start",
              background: "rgba(255,255,255,0.18)",
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 800,
              padding: "8px 14px",
              width: "fit-content",
            }}
          >
            Active route state
          </div>
          <div style={{ fontSize: 24, fontWeight: 800, textTransform: "capitalize" }}>
            {selectedItem}
          </div>
          <p style={{ lineHeight: 1.65, margin: 0, opacity: 0.86 }}>{notes}</p>
        </div>
      </aside>
    </div>
  );
}
