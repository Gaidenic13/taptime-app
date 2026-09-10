import React from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../App.jsx";
import { useI18n } from "../i18n.jsx";

// Mobile overflow menu — settings-style grouped list matching the tab bar's
// tone: section labels, rounded cards, one row per destination.
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
      <div className="page-head" style={{ marginBottom: 6 }}>
        <h1>{t("nav.more")}</h1>
        <p>{user.first_name} {user.last_name}{user.job_title && user.job_title !== "—" ? ` · ${user.job_title}` : ""}</p>
      </div>
      {groups.map((g) => (
        <React.Fragment key={g.key}>
          <div className="menu-sec">{t(g.key)}</div>
          <div className="menu-card">
            {g.items.map((n) => (
              <Link key={n.to} to={n.to} className="menu-row">
                {t(n.key)}
                <span className="chev">›</span>
              </Link>
            ))}
          </div>
        </React.Fragment>
      ))}
    </>
  );
}
