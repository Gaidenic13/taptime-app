import React from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../App.jsx";
import { useI18n } from "../i18n.jsx";

// Mobile overflow menu: everything that doesn't fit in the bottom tab bar.
// Mirrors the desktop sidebar's grouped navigation.
export default function More() {
  const { user } = useAuth();
  const { t } = useI18n();
  const isAdmin = user.role === "admin" || user.role === "owner";

  const groups = [
    { key: "nav.g.clinic", items: [
      { to: "/employees", key: "nav.employees" },
      { to: "/reports", key: "nav.reports" },
    ]},
    { key: "nav.g.me", items: [
      { to: "/me", key: "nav.me" },
      { to: "/attendance", key: "nav.attendance" },
      { to: "/schedule", key: "nav.schedule" },
      { to: "/leave", key: "nav.leave" },
    ]},
    ...(isAdmin ? [{ key: "nav.g.admin", items: [
      { to: "/setup", key: "nav.setup" },
      { to: "/settings", key: "nav.settings" },
    ]}] : []),
  ];

  return (
    <>
      <div className="page-head">
        <h1>{t("nav.more")}</h1>
      </div>
      {groups.map((g) => (
        <div className="card" key={g.key}>
          <h2>{t(g.key)}</h2>
          {g.items.map((n) => (
            <Link key={n.to} to={n.to} className="list-item" style={{ display: "block", fontWeight: 600, color: "var(--ink)" }}>
              {t(n.key)} →
            </Link>
          ))}
        </div>
      ))}
    </>
  );
}
