import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, getGeo, fmtMin, fmtTime, fmtLongDate } from "../api.js";
import { useAuth } from "../App.jsx";
import { useI18n } from "../i18n.jsx";

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="time">
      {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
      <span className="sec">:{String(now.getSeconds()).padStart(2, "0")}</span>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [today, setToday] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api("/me").then((d) => setToday(d.today)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const act = async (route) => {
    setError(""); setBusy(true);
    try {
      // Location is a risk signal for the server, never a client-side gate.
      const body = route === "clock-in" ? { geo: await getGeo() } : {};
      const d = await api(`/attendance/${route}`, { method: "POST", body });
      setToday(d.today);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!today) return null;
  const s = today.status;
  const shift = today.shift;
  const att = today.attendance;

  return (
    <>
      <div className="page-head">
        <h1>{t("dash.hi", { name: user.first_name })}</h1>
        <p>{fmtLongDate()}</p>
      </div>

      <div className="clock-hero">
        <span className={`pill ${s}`}>{t(`status.${s}`)}</span>
        <Clock />
        <div className="sub">
          {shift
            ? `${t("dash.todayShift", { start: shift.start_time, end: shift.end_time })} · ${user.job_title}`
            : s === "leave" ? t("dash.onLeave") : t("dash.noShift")}
        </div>
        {att?.clock_in && (
          <div className="sub" style={{ marginTop: 6 }}>
            {t("dash.in", { time: fmtTime(att.clock_in) })}
            {att.clock_out ? ` · ${t("dash.out", { time: fmtTime(att.clock_out) })}` : ""}
            {` · ${t("dash.workedFor", { dur: fmtMin(today.worked_min) })}`}
            {today.break_min > 0 ? ` · ${t("dash.breaksFor", { dur: fmtMin(today.break_min) })}` : ""}
          </div>
        )}
        <div className="clock-actions">
          {s === "working" && (
            <>
              <button className="btn subtle" disabled={busy} onClick={() => act("break-start")}>{t("dash.startBreak")}</button>
              <button className="btn" disabled={busy} onClick={() => act("clock-out")}>{t("dash.clockOut")}</button>
            </>
          )}
          {s === "break" && (
            <button className="btn" disabled={busy} onClick={() => act("break-end")}>{t("dash.endBreak")}</button>
          )}
          {(s === "upcoming" || s === "late" || (s === "no_shift" && !att)) && (
            <button className="btn" disabled={busy} onClick={() => act("clock-in")}>{t("dash.clockIn")}</button>
          )}
          {s === "complete" && <div className="sub">{t("dash.complete", { dur: fmtMin(today.worked_min) })}</div>}
          {s === "requires_review" && <div className="sub">{t("dash.reviewNote")}</div>}
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}
      {s === "late" && (
        <div className="card tinted">
          <strong>{t("dash.lateTitle")}</strong>
          <p className="small muted" style={{ marginTop: 4 }}>
            {t("dash.lateBody", { time: shift?.start_time })}{" "}
            <Link to="/attendance">{t("dash.qAttendance")}</Link>
          </p>
        </div>
      )}

      <div className="grid2">
        <div className="card">
          <h2>{t("dash.quick")}</h2>
          <div className="row" style={{ marginTop: 10 }}>
            <Link className="btn subtle small" to="/attendance">{t("dash.qAttendance")}</Link>
            <Link className="btn subtle small" to="/leave">{t("dash.qLeave")}</Link>
            <Link className="btn subtle small" to="/schedule">{t("dash.qSchedule")}</Link>
          </div>
        </div>
        <div className="card">
          <h2>{t("dash.summary")}</h2>
          <table className="kv">
            <tbody>
              <tr><td className="muted">{t("common.scheduled")}</td><td>{shift ? `${shift.start_time} – ${shift.end_time}` : "—"}</td></tr>
              <tr><td className="muted">{t("dash.clockIn")}</td><td>{fmtTime(att?.clock_in)}</td></tr>
              <tr><td className="muted">{t("dash.clockOut")}</td><td>{fmtTime(att?.clock_out)}</td></tr>
              <tr><td className="muted">{t("common.breaks")}</td><td>{fmtMin(today.break_min)}</td></tr>
              <tr><td className="muted">{t("common.worked")}</td><td>{fmtMin(today.worked_min)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
