import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtMin, fmtTime, fmtLongDate } from "../api.js";
import { useI18n } from "../i18n.jsx";

const STAT_ORDER = [
  ["working", "team.workingNow"],
  ["break", "team.onBreak"],
  ["upcoming", "team.notStarted"],
  ["late", "team.late"],
  ["absent", "team.absent"],
  ["leave", "team.onLeave"],
  ["requires_review", "team.needsReview"],
  ["complete", "team.doneToday"],
];

export default function TeamToday() {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [locations, setLocations] = useState([]);
  const [locId, setLocId] = useState("");
  const load = (l = locId) => api(`/team/today${l ? `?location_id=${l}` : ""}`).then(setData);
  useEffect(() => { api("/directory").then((d) => setLocations(d.locations)); }, []);
  useEffect(() => {
    load(locId);
    const timer = setInterval(() => load(locId), 60000);
    return () => clearInterval(timer);
  }, [locId]);

  if (!data) return null;
  const byRole = {};
  for (const r of data.roster) (byRole[r.job_title] = byRole[r.job_title] || []).push(r);
  const pa = data.pending_actions;
  const actionItems = [
    [pa.leaves, "team.pLeaves", "/approvals"],
    [pa.corrections, "team.pCorrections", "/approvals"],
    [pa.overtime, "team.pOvertime", "/approvals"],
    [pa.reviews, "team.pReviews", "/approvals"],
    [pa.flags, "team.pFlags", "/approvals"],
    [pa.staffing_gaps, "team.pGaps", null],
  ].filter(([n]) => n > 0);

  return (
    <>
      <div className="page-head spread">
        <div>
          <h1>{t("team.title")}</h1>
          <p>{fmtLongDate()} · {t("team.live")}</p>
        </div>
        {locations.length > 1 && (
          <div className="seg">
            <button className={locId === "" ? "active" : ""} onClick={() => setLocId("")}>{t("team.allLocations")}</button>
            {locations.map((l) => (
              <button key={l.id} className={locId === String(l.id) ? "active" : ""} onClick={() => setLocId(String(l.id))}>
                {l.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="stats">
        {STAT_ORDER.map(([k, key]) => (
          <div className={`stat ${k === "working" ? "hl" : ""}`} key={k}>
            <div className="n">{data.counts[k] || 0}</div>
            <div className="l">{t(key)}</div>
          </div>
        ))}
      </div>

      {actionItems.length > 0 && (
        <div className="card tinted">
          <h2>{t("team.pending")}</h2>
          {actionItems.map(([n, key, link], i) => (
            <div key={i} className="spread list-item">
              <span><strong>{n}</strong> {t(key)}</span>
              {link && <Link className="btn small subtle" to={link}>{t("common.review")}</Link>}
            </div>
          ))}
        </div>
      )}

      {data.staffing.alerts.length > 0 && (
        <div className="card">
          <h2>{t("team.alerts")}</h2>
          {data.staffing.alerts.map((a, i) => (
            <div key={i} className={`alert-line ${a.kind === "scheduled" ? "softer" : ""}`}>
              {t(a.kind === "present" ? "team.alertNow" : "team.alertSched", {
                n: a.missing, role: a.role, location: a.location, band: a.band,
              })}
            </div>
          ))}
        </div>
      )}

      {data.staffing.bands.length > 0 && (
        <div className="card">
          <h2>{t("team.rvsp")}</h2>
          <p className="small muted">{t("team.rvspSub")}</p>
          {data.staffing.bands.map((b) => (
            <div className="band-row" key={b.id}>
              <div>
                <strong>{b.role}</strong> <span className="muted small">· {b.location} · {b.band}</span>
              </div>
              <div className="band-nums">
                <span className="muted">{t("team.req")} {b.required}</span>
                <span className={b.scheduled_gap ? "warn" : "ok"}>{t("team.sched")} {b.scheduled}</span>
                {b.present != null
                  ? <span className={b.present_gap ? "warn" : "ok"}>{t("team.present")} {b.present}</span>
                  : <span className="muted">—</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>{t("team.coverage")}</h2>
        <div className="grid2" style={{ marginTop: 12 }}>
          {Object.entries(data.coverage).map(([role, c]) => {
            const pct = c.scheduled ? Math.round((c.present / c.scheduled) * 100) : 0;
            const cls = pct >= 100 ? "" : pct >= 60 ? "warn" : "bad";
            return (
              <div key={role}>
                <div className="spread">
                  <strong>{role}</strong>
                  <span className="small" style={pct < 100 ? { color: "var(--red)", fontWeight: 600 } : { color: "var(--muted)" }}>
                    {t("team.presentOf", { a: c.present, b: c.scheduled })}
                  </span>
                </div>
                <div className="coverage-bar"><div className={cls} style={{ width: `${Math.min(100, pct)}%` }} /></div>
              </div>
            );
          })}
        </div>
      </div>

      {Object.entries(byRole).map(([role, people]) => (
        <div className="card" key={role}>
          <h2>{role}</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("common.name")}</th><th>{t("common.location")}</th><th>{t("common.shift")}</th>
                  <th>{t("team.clockIn")}</th><th>{t("team.clockOut")}</th>
                  <th>{t("common.worked")}</th><th>{t("team.risk")}</th><th>{t("common.status")}</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id}>
                    <td><strong>{p.name}</strong></td>
                    <td>{p.location || "—"}</td>
                    <td>{p.shift || "—"}</td>
                    <td>{fmtTime(p.clock_in)}{p.method && p.method !== "WEB" ? <span className="small muted"> · {p.method}</span> : ""}</td>
                    <td>{fmtTime(p.clock_out)}</td>
                    <td>{p.worked_min ? fmtMin(p.worked_min) : "—"}</td>
                    <td>{p.risk && p.risk !== "low"
                      ? <span className={`pill risk-${p.risk}`}>{p.risk}</span> : "—"}</td>
                    <td><span className={`pill ${p.status}`}>{t(`status.${p.status}`)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}
