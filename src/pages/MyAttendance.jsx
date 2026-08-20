import React, { useEffect, useState } from "react";
import { api, fmtMin, fmtTime, fmtDate, fmtMonth } from "../api.js";
import { useI18n, dateLocale } from "../i18n.jsx";

const monthStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  return monthStr(new Date(y, m - 1 + delta, 1));
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Current-week bar chart in the "weekly activity" style: dashed gridlines,
// soft rounded bars, day initials underneath.
function WeekChart({ days }) {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const rec = days.find((x) => x.date === iso);
    return { date: d, worked: rec?.worked_min || 0 };
  });
  const max = Math.max(8 * 60, ...week.map((w) => w.worked));
  const lines = [
    { frac: 0.25, label: fmtMin(Math.round(max * 0.75)) },
    { frac: 0.5, label: fmtMin(Math.round(max * 0.5)) },
    { frac: 0.75, label: fmtMin(Math.round(max * 0.25)) },
  ];
  return (
    <>
      <div className="chart">
        {lines.map((l, i) => (
          <div key={i} className="gridline" style={{ top: `${l.frac * 100}%` }}><span>{l.label}</span></div>
        ))}
        <div className="gridline" style={{ top: 0 }} />
        <div className="gridline" style={{ bottom: 0, top: "auto" }} />
        <div className="bars">
          {week.map((w, i) => (
            <div className="bar-col" key={i}>
              <div className="bar" style={{ height: `${Math.min(100, (w.worked / max) * 100)}%` }} />
            </div>
          ))}
        </div>
      </div>
      <div className="chart-days">
        {week.map((w, i) => (
          <div key={i}>
            {w.date.toLocaleDateString(dateLocale(), { weekday: "short" }).replace(".", "")}
            <em>{w.date.getDate()}</em>
          </div>
        ))}
      </div>
    </>
  );
}

function CorrectionModal({ day, onClose, onDone }) {
  const { t } = useI18n();
  const [kind, setKind] = useState(day.attendance?.clock_in ? "missing_out" : "missing_in");
  const [reqIn, setReqIn] = useState("");
  const [reqOut, setReqOut] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    try {
      await api("/corrections", {
        method: "POST",
        body: { date: day.date, kind, requested_in: reqIn, requested_out: reqOut, reason },
      });
      onDone();
    } catch (err) {
      setError(err.message);
    }
  };

  const needsIn = kind === "missing_in" || kind === "wrong_hours";
  const needsOut = kind === "missing_out" || kind === "wrong_hours";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="card modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{t("att.reqCorrection", { date: fmtDate(day.date) })}</h2>
        <label className="field">
          <span>{t("att.issue")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="missing_in">{t("att.missingIn")}</option>
            <option value="missing_out">{t("att.missingOut")}</option>
            <option value="wrong_hours">{t("att.wrongHours")}</option>
            <option value="other">{t("att.other")}</option>
          </select>
        </label>
        {needsIn && (
          <label className="field"><span>{t("att.correctIn")}</span>
            <input type="time" value={reqIn} onChange={(e) => setReqIn(e.target.value)} required />
          </label>
        )}
        {needsOut && (
          <label className="field"><span>{t("att.correctOut")}</span>
            <input type="time" value={reqOut} onChange={(e) => setReqOut(e.target.value)} required />
          </label>
        )}
        <label className="field"><span>{t("common.reason")}</span>
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("att.reasonPh")} required />
        </label>
        {error && <div className="error-box">{error}</div>}
        <div className="row">
          <button className="btn" type="submit">{t("att.submit")}</button>
          <button className="btn subtle" type="button" onClick={onClose}>{t("common.cancel")}</button>
        </div>
      </form>
    </div>
  );
}

export default function MyAttendance() {
  const { t } = useI18n();
  const [month, setMonth] = useState(monthStr());
  const [data, setData] = useState(null);
  const [correcting, setCorrecting] = useState(null);
  const [notice, setNotice] = useState("");

  const load = () => api(`/attendance/history?month=${month}`).then(setData);
  useEffect(() => { load(); }, [month]);

  if (!data) return null;
  const totalWorked = data.days.reduce((s, d) => s + (d.attendance?.clock_out ? d.worked_min : 0), 0);

  const dayState = (d) => {
    if (d.leave) return ["leave", t(`leave.${d.leave.type}`)];
    if (d.attendance?.status === "requires_review") return ["requires_review", t("status.requires_review")];
    if (d.attendance?.clock_out) return ["complete", t("status.complete")];
    if (d.attendance?.clock_in) return ["working", t("status.open")];
    if (d.shift && d.date < todayIso()) return ["absent", t("status.missing")];
    return ["off", d.shift ? t("status.scheduled") : t("status.no_shift")];
  };

  return (
    <>
      <div className="page-head spread">
        <div>
          <h1>{t("att.title")}</h1>
          <p>{t("att.workedMonth")}: <strong>{fmtMin(totalWorked)}</strong></p>
        </div>
        <div className="row">
          <button className="btn subtle small" onClick={() => setMonth(shiftMonth(month, -1))}>←</button>
          <strong>{fmtMonth(month)}</strong>
          <button className="btn subtle small" onClick={() => setMonth(shiftMonth(month, 1))}>→</button>
        </div>
      </div>

      {month === monthStr() && (
        <div className="card">
          <h2>{t("att.weekly")}</h2>
          <WeekChart days={data.days} />
        </div>
      )}

      {notice && <div className="ok-box">{notice}</div>}

      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("common.date")}</th><th>{t("common.scheduled")}</th><th>{t("att.actual")}</th>
              <th>{t("common.breaks")}</th><th>{t("common.worked")}</th><th>{t("common.status")}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {data.days.length === 0 && (
              <tr><td colSpan={7} className="empty">{t("att.none")}</td></tr>
            )}
            {data.days.map((d) => {
              const [cls, text] = dayState(d);
              return (
                <tr key={d.date}>
                  <td><strong>{fmtDate(d.date)}</strong></td>
                  <td>{d.shift ? `${d.shift.start_time}–${d.shift.end_time}` : "—"}</td>
                  <td>
                    {d.attendance?.clock_in
                      ? `${fmtTime(d.attendance.clock_in)}–${d.attendance.clock_out ? fmtTime(d.attendance.clock_out) : "…"}`
                      : "—"}
                  </td>
                  <td>{d.break_min ? fmtMin(d.break_min) : "—"}</td>
                  <td>{d.attendance?.clock_out ? fmtMin(d.worked_min) : "—"}</td>
                  <td>
                    <span className={`pill ${cls}`}>{text}</span>
                    {d.correction && (
                      <span className={`pill ${d.correction.status}`} style={{ marginLeft: 6 }}>
                        {t("att.correction")} · {t(`status.${d.correction.status}`)}
                      </span>
                    )}
                  </td>
                  <td>
                    {d.correction?.status !== "pending" && (
                      <button className="btn subtle small" onClick={() => setCorrecting(d)}>{t("att.fix")}</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {correcting && (
        <CorrectionModal
          day={correcting}
          onClose={() => setCorrecting(null)}
          onDone={() => {
            setCorrecting(null);
            setNotice(t("att.submitted"));
            load();
          }}
        />
      )}
    </>
  );
}
