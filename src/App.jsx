import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { Routes, Route, NavLink, Navigate, useLocation, useNavigate } from "react-router-dom";
import { api, setToken } from "./api.js";
import { I18nProvider, useI18n, LangSwitch } from "./i18n.jsx";
import Bell from "./components/Bell.jsx";
import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
import Setup from "./pages/Setup.jsx";
import Terminal from "./pages/Terminal.jsx";
import Factory from "./pages/Factory.jsx";
import Checkpoint from "./pages/Checkpoint.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import MyAttendance from "./pages/MyAttendance.jsx";
import Schedule from "./pages/Schedule.jsx";
import Leave from "./pages/Leave.jsx";
import TeamToday from "./pages/TeamToday.jsx";
import Days from "./pages/Days.jsx";
import Approvals from "./pages/Approvals.jsx";
import Employees from "./pages/Employees.jsx";
import Reports from "./pages/Reports.jsx";
import Settings from "./pages/Settings.jsx";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

// Three parts of the app (plan: employee / place manager / administration).
// Employees get a flat, minimal menu; managers and admins get grouped sections.
const EMPLOYEE_NAV = [
  { to: "/", key: "nav.dashboard", end: true },
  { to: "/attendance", key: "nav.attendance" },
  { to: "/schedule", key: "nav.schedule" },
  { to: "/leave", key: "nav.leave" },
];
const MANAGER_GROUPS = [
  { key: "nav.g.clinic", items: [
    { to: "/team", key: "nav.team" },
    { to: "/days", key: "nav.days" },
    { to: "/approvals", key: "nav.approvals" },
    { to: "/reports", key: "nav.reports" },
    { to: "/employees", key: "nav.employees" },
  ]},
  { key: "nav.g.me", items: [
    { to: "/me", key: "nav.me" },
    { to: "/attendance", key: "nav.attendance" },
    { to: "/schedule", key: "nav.schedule" },
    { to: "/leave", key: "nav.leave" },
  ]},
  { key: "nav.g.admin", admin: true, items: [
    { to: "/setup", key: "nav.setup" },
    { to: "/settings", key: "nav.settings" },
  ]},
];

const MOBILE_EMPLOYEE = ["/", "/attendance", "/schedule", "/leave"];
const MOBILE_MANAGER = ["/team", "/days", "/approvals", "/me"];

function Shell({ children }) {
  const { user, logout, pendingCount } = useAuth();
  const { t } = useI18n();
  const isManager = user.role !== "employee";
  const isAdmin = user.role === "admin" || user.role === "owner";
  const groups = isManager
    ? MANAGER_GROUPS.filter((g) => !g.admin || isAdmin)
    : [{ items: EMPLOYEE_NAV }];
  const flat = groups.flatMap((g) => g.items);
  const mobileSet = isManager ? MOBILE_MANAGER : MOBILE_EMPLOYEE;
  const mobileItems = mobileSet.map((to) => flat.find((n) => n.to === to)).filter(Boolean);

  const badge = (n) => (n.to === "/approvals" && pendingCount > 0 ? ` (${pendingCount})` : "");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">T</span>TapTime</div>
        {groups.map((g, gi) => (
          <React.Fragment key={gi}>
            {g.key && <div className="nav-sec">{t(g.key)}</div>}
            {g.items.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => "nav-link" + (isActive ? " active" : "")}>
                {t(n.key)}{badge(n)}
              </NavLink>
            ))}
          </React.Fragment>
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
  const navigate = useNavigate();

  // Out-of-the-box flow: an admin whose clinic hasn't finished onboarding is
  // taken straight to the setup wizard.
  const checkOnboarding = async (u) => {
    if (u.role !== "admin" && u.role !== "owner") return;
    try {
      const d = await api("/admin/settings");
      if (!d.settings.onboarded) navigate("/setup", { replace: true });
    } catch { /* non-fatal */ }
  };

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
      .then((d) => { setUser(d.user); refreshPending(d.user); checkOnboarding(d.user); })
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async (email, password) => {
    const d = await api("/auth/login", { method: "POST", body: { email, password } });
    setToken(d.token);
    setUser(d.user);
    refreshPending(d.user);
    checkOnboarding(d.user);
    return d.user;
  };

  const logout = async () => {
    try { await api("/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    setToken(null);
    setUser(null);
  };

  const adoptSession = (u) => { setUser(u); refreshPending(u); };
  const ctx = { user, login, logout, adoptSession, pendingCount, refreshPending };

  if (location.pathname === "/terminal") return <Terminal />;
  if (location.pathname === "/factory") return <Factory />;
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
        <Routes>
          <Route path="/signup" element={<Signup />} />
          <Route path="*" element={<Login />} />
        </Routes>
      </AuthCtx.Provider>
    );
  }

  const isManager = user.role !== "employee";
  const isAdmin = user.role === "admin" || user.role === "owner";
  return (
    <AuthCtx.Provider value={ctx}>
      <Shell>
        <Routes>
          {/* Managers land on the clinic view; their personal day lives at /me. */}
          <Route path="/" element={isManager ? <Navigate to="/team" replace /> : <Dashboard />} />
          <Route path="/me" element={<Dashboard />} />
          <Route path="/attendance" element={<MyAttendance />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/leave" element={<Leave />} />
          {isManager && <Route path="/team" element={<TeamToday />} />}
          {isManager && <Route path="/days" element={<Days />} />}
          {isManager && <Route path="/approvals" element={<Approvals />} />}
          {isManager && <Route path="/employees" element={<Employees />} />}
          {isManager && <Route path="/reports" element={<Reports />} />}
          {isAdmin && <Route path="/setup" element={<Setup />} />}
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
