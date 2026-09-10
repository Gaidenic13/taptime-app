import React, { useEffect, useState } from "react";
import { api, fmtTime, fmtMin, fmtDate } from "../api.js";
import { useAuth } from "../App.jsx";
import { useI18n, LangSwitch } from "../i18n.jsx";

// The member's personal view: today's in/out pairs, the last 7 days, and the
// month total. No menus — they reach this from the scan page or the app root.
const monthStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default function MemberHome() {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const [today, setToday] = useState(null);
  const [history, setHistory] = useState(null);

  useEffect(() => {
    api("/me").then((d) => setToday(d.today)).catch(() => {});
    api(`/attendance/history?month=${monthStr()}`).then(setHistory).catch(() => {});
  }, []);

  const days = (history?.days || []).filter((d) => d.sessions?.length);
  const weekCutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const week = days.filter((d) => d.date >= weekCutoff && d.date < todayIso());
  const monthTotal = days.reduce((s, d) => s + (d.worked_min || 0), 0);

  return (
    <div className="login-wrap" style={{ alignItems: "start", paddingTop: 28 }}>
      <div className="corner-lang"><LangSwitch /></div>
      <div className="card login-card" style={{ textAlign: "left" }}>
        <div className="brand" style={{ justifyContent: "flex-start" }}><span className="brand-mark">T</span>TapTime</div>
        <h2 style={{ marginTop: 6 }}>{t("dash.hi", { name: user.first_name })}</h2>
        {today && <span className={`pill ${today.status}`}>{t(`status.${today.status}`)}</span>}

        {today?.sessions?.length > 0 && (
          <div className="history" style={{ marginTop: 14 }}>
            <div className="menu-sec" style={{ margin: "0 0 6px" }}>{t("cp.today")}</div>
            {today.sessions.map((s) => (
              <div className="history-row" key={s.id}>
                <span>{fmtTime(s.clock_in)}</span>
                <span className="history-arrow">→</span>
                <span className={s.clock_out ? "" : "muted"}>{s.clock_out ? fmtTime(s.clock_out) : "…"}</span>
                <span className="history-dur muted">{s.clock_out ? fmtMin(s.worked_minutes ?? 0) : t("status.working")}</span>
              </div>
            ))}
            <div className="history-total">{t("cp.workedToday", { dur: fmtMin(today.worked_min) })}</div>
          </div>
        )}

        {week.length > 0 && (
          <div className="history" style={{ marginTop: 18 }}>
            <div className="menu-sec" style={{ margin: "0 0 6px" }}>{t("member.week")}</div>
            {week.map((d) => (
              <div className="history-row" key={d.date} style={{ gridTemplateColumns: "1fr auto" }}>
                <span>{fmtDate(d.date)} <span className="muted small">· {t("team.sessionsN", { n: d.sessions.length })}</span></span>
                <span className="history-dur" style={{ color: "var(--ink)" }}>{fmtMin(d.worked_min)}</span>
              </div>
            ))}
          </div>
        )}

        {history && (
          <div className="history-total" style={{ marginTop: 14, display: "flex", justifyContent: "space-between" }}>
            <span className="muted" style={{ fontWeight: 500 }}>{t("member.month")}</span>
            <span>{fmtMin(monthTotal)}</span>
          </div>
        )}

        {user.code && (
          <div className="card tinted" style={{ marginTop: 18, padding: 14 }}>
            <div className="small muted">{t("member.yourCode")}</div>
            <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: "0.12em" }}>{user.code}</div>
            <div className="small muted">{t("member.codeNote")}</div>
          </div>
        )}
        <p className="small muted" style={{ marginTop: 14 }}>{t("member.note")}</p>
        <button className="btn subtle" style={{ marginTop: 6 }} onClick={logout}>{t("nav.logout")}</button>
      </div>
    </div>
  );
}
