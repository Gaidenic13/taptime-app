import React, { useEffect, useState } from "react";
import { api, fmtMin, fmtTime, fmtDate } from "../api.js";
import { useI18n } from "../i18n.jsx";

// "Days" database view (manager): every check-in/check-out pair per person for
// a chosen day, with daily totals — the registry behind payroll.
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const addDays = (str, n) =>
  new Date(new Date(str + "T12:00:00").getTime() + n * 86400000).toISOString().slice(0, 10);

export default function Days() {
  const { t } = useI18n();
  const [date, setDate] = useState(todayIso());
  const [locations, setLocations] = useState([]);
  const [locId, setLocId] = useState("");
  const [data, setData] = useState(null);

  useEffect(() => { api("/directory").then((d) => setLocations(d.locations)); }, []);
  useEffect(() => {
    const params = new URLSearchParams({ date });
    if (locId) params.set("location_id", locId);
    api(`/team/today?${params}`).then(setData);
  }, [date, locId]);

  if (!data) return null;
  const rows = data.roster.filter((r) => r.sessions.length > 0 || r.status === "leave");
  const totalMin = rows.reduce((s, r) => s + (r.worked_min || 0), 0);

  return (
    <>
      <div className="page-head spread">
        <div>
          <h1>{t("days.title")}</h1>
          <p>{t("days.sub")}</p>
        </div>
        <div className="row">
          {locations.length > 1 && (
            <select value={locId} onChange={(e) => setLocId(e.target.value)} style={{ width: "auto" }}>
              <option value="">{t("team.allLocations")}</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          )}
          <button className="btn subtle small" onClick={() => setDate(addDays(date, -1))}>←</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: "auto" }} />
          <button className="btn subtle small" onClick={() => setDate(addDays(date, 1))}>→</button>
          <button className="btn subtle small" onClick={() => setDate(todayIso())}>{t("common.today")}</button>
        </div>
      </div>

      <div className="stats">
        <div className="stat hl"><div className="n">{fmtMin(totalMin)}</div><div className="l">{t("days.totalDay")}</div></div>
        <div className="stat"><div className="n">{rows.filter((r) => r.sessions.length > 0).length}</div><div className="l">{t("days.people")}</div></div>
        <div className="stat"><div className="n">{fmtDate(date)}</div><div className="l">{t("common.date")}</div></div>
      </div>

      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("common.name")}</th><th>{t("common.role")}</th>
              <th>{t("days.sessions")}</th><th>Total</th><th>{t("common.status")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} className="empty">{t("days.none")}</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.name}</strong></td>
                <td className="small">{r.job_title}</td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    {r.sessions.map((s, i) => (
                      <span key={i} className={`pill ${s.out ? "no_shift" : "working"}`}>
                        {fmtTime(s.in)} → {s.out ? fmtTime(s.out) : "…"}
                        {s.method && s.method !== "WEB" ? ` · ${s.method}` : ""}
                        {s.device_id ? ` · ${t("days.device")} #${s.device_id}` : ""}
                      </span>
                    ))}
                    {r.sessions.length === 0 && "—"}
                  </div>
                </td>
                <td><strong>{r.worked_min ? fmtMin(r.worked_min) : "—"}</strong></td>
                <td><span className={`pill ${r.status}`}>{t(`status.${r.status}`)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
