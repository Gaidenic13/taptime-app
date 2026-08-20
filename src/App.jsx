import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { Routes, Route, NavLink, Navigate, useLocation } from "react-router-dom";
import { api, setToken } from "./api.js";
import { I18nProvider, useI18n, LangSwitch } from "./i18n.jsx";
import Bell from "./components/Bell.jsx";
import Login from "./pages/Login.jsx";
import Terminal from "./pages/Terminal.jsx";
import Checkpoint from "./pages/Checkpoint.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import MyAttendance from "./pages/MyAttendance.jsx";
import Schedule from "./pages/Schedule.jsx";
import Leave from "./pages/Leave.jsx";
import TeamToday from "./pages/TeamToday.jsx";
import Approvals from "./pages/Approvals.jsx";
import Employees from "./pages/Employees.jsx";
import Reports from "./pages/Reports.jsx";
import Settings from "./pages/Settings.jsx";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

const NAV = [
  { to: "/", key: "nav.dashboard", end: true },
  { to: "/attendance", key: "nav.attendance" },
  { to: "/schedule", key: "nav.schedule" },
  { to: "/leave", key: "nav.leave" },
  { to: "/team", key: "nav.team", manager: true },
  { to: "/approvals", key: "nav.approvals", manager: true },
  { to: "/employees", key: "nav.employees", manager: true },
  { to: "/reports", key: "nav.reports", manager: true },
  { to: "/settings", key: "nav.settings", admin: true },
];

const MOBILE_EMPLOYEE = ["/", "/attendance", "/schedule", "/leave"];
const MOBILE_MANAGER = ["/", "/team", "/approvals", "/reports"];

function Shell({ children }) {
  const { user, logout, pendingCount } = useAuth();
  const { t } = useI18n();
  const isManager = user.role !== "employee";
  const isAdmin = user.role === "admin" || user.role === "owner";
  const items = NAV.filter((n) => (!n.manager || isManager) && (!n.admin || isAdmin));
  const mobileSet = isManager ? MOBILE_MANAGER : MOBILE_EMPLOYEE;
  const mobileItems = items.filter((n) => mobileSet.includes(n.to));

  const badge = (n) => (n.to === "/approvals" && pendingCount > 0 ? ` (${pendingCount})` : "");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">T</span>TapTime</div>
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => "nav-link" + (isActive ? " active" : "")}>
            {t(n.key)}{badge(n)}
          </NavLink>
        ))}
        <div className="nav-spacer" />
        <div style={{ padding: "0 8px 14px" }}><LangSwitch /></div>
        <div className="nav-user">
          <strong>{user.first_name} {user.last_name}</strong>
          <span>{user.job_title}</span>
          <button onClick={logout}>{t("nav.logout")}</button>
        </div>
      </aside>
      <main className="main">
        <div className="topline">
          <div className="mobile-topbar">
            <div className="brand"><span className="brand-mark">T</span>TapTime</div>
          </div>
          <div className="topline-actions">
            <span className="mobile-only"><LangSwitch compact /></span>
            <Bell />
            <button className="btn small subtle mobile-only" onClick={logout}>{t("nav.logout")}</button>
          </div>
        </div>
        {children}
      </main>
      <nav className="tabbar">
        {mobileItems.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "active" : "")}>
            {n.to === "/attendance" ? t("nav.attendance.short") : t(n.key)}{badge(n)}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function AppInner() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const location = useLocation();

  const refreshPending = useCallback(async (u) => {
    const who = u || user;
    if (!who || who.role === "employee") return;
    try {
      const d = await api("/approvals");
      setPendingCount(
        d.leaves.length + d.corrections.length + d.overtime.length + d.reviews.length + d.flags.length
      );
    } catch { /* non-fatal */ }
  }, [user]);

  useEffect(() => {
    api("/me")
      .then((d) => { setUser(d.user); refreshPending(d.user); })
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async (email, password) => {
    const d = await api("/auth/login", { method: "POST", body: { email, password } });
    setToken(d.token);
    setUser(d.user);
    refreshPending(d.user);
    return d.user;
  };

  const logout = async () => {
    try { await api("/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    setToken(null);
    setUser(null);
  };

  const ctx = { user, login, logout, pendingCount, refreshPending };

  if (location.pathname === "/terminal") return <Terminal />;
  if (loading) return null;
  if (location.pathname.startsWith("/checkpoint/")) {
    return (
      <AuthCtx.Provider value={ctx}>
        <Routes>
          <Route path="/checkpoint/:code" element={<Checkpoint />} />
        </Routes>
      </AuthCtx.Provider>
    );
  }

  if (!user) {
    return (
      <AuthCtx.Provider value={ctx}>
        <Login />
      </AuthCtx.Provider>
    );
  }

  const isManager = user.role !== "employee";
  const isAdmin = user.role === "admin" || user.role === "owner";
  return (
    <AuthCtx.Provider value={ctx}>
      <Shell>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/attendance" element={<MyAttendance />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/leave" element={<Leave />} />
          {isManager && <Route path="/team" element={<TeamToday />} />}
          {isManager && <Route path="/approvals" element={<Approvals />} />}
          {isManager && <Route path="/employees" element={<Employees />} />}
          {isManager && <Route path="/reports" element={<Reports />} />}
          {isAdmin && <Route path="/settings" element={<Settings />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </AuthCtx.Provider>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <AppInner />
    </I18nProvider>
  );
}
