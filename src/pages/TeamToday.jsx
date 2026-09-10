import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtMin, fmtTime, fmtLongDate } from "../api.js";
import { useI18n } from "../i18n.jsx";

// The manager's board answers one question at a glance: who is in right now,
// since when, and who already left (with their hours). Present people first.
const ORDER = { working: 0, break: 0, requires_review: 0, complete: 1, late: 2, upcoming: 3, absent: 4, leave: 5, no_shift: 6 };
const IN = new Set(["working", "break", "requires_review"]);

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
  const roster = [...data.roster].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.name.localeCompare(b.name));
  const inNow = roster.filter((r) => IN.has(r.status)).length;
  const outToday = roster.filter((r) => r.status === "complete").length;
  const notYet = roster.length - inNow - outToday;
  const pa = data.pending_actions;
  const actionItems = [
    [pa.leaves, "team.pLeaves"], [pa.corrections, "team.pCorrections"], [pa.overtime, "team.pOvertime"],
    [pa.reviews, "team.pReviews"], [pa.flags, "team.pFlags"],
  ].filter(([n]) => n > 0);

  return (
    <>
      <div className="page-head">
        <h1>{t("team.title")}</h1>
        <p>{fmtLongDate()} · {t("team.live")}</p>
      </div>

      {locations.length > 1 && (
        <div className="seg" style={{ marginBottom: 14 }}>
          <button className={locId === "" ? "active" : ""} onClick={() => setLocId("")}>{t("team.allLocations")}</button>
          {locations.map((l) => (
            <button key={l.id} className={locId === String(l.id) ? "active" : ""} onClick={() => setLocId(String(l.id))}>{l.name}</button>
          ))}
        </div>
      )}

      <div className="stats" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <div className="stat hl"><div className="n">{inNow}</div><div className="l">{t("team.inNow")}</div></div>
        <div className="stat"><div className="n">{outToday}</div><div className="l">{t("team.outToday")}</div></div>
        <div className="stat"><div className="n">{notYet}</div><div className="l">{t("team.notYet")}</div></div>
      </div>

      {data.pending?.length > 0 && (
        <div className="card tinted">
          <h2>{t("team.pendingMembers")}</h2>
          <p className="small muted">{t("team.pendingSub")}</p>
          {data.pending.map((p) => (
            <div className="person-row" key={p.id}>
              <div className="person-main">
                <strong>{p.name}</strong>
                <div className="small muted">
                  {p.kind === "join" ? t("ap.askedToJoin") : t("ap.newPhone")}
                  {p.kind === "link" && ` · ${p.replaces ? t("ap.replacesPhone") : t("ap.firstPhone")}`}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn approve small" onClick={async () => { await api(`/phone-links/${p.id}/approve`, { method: "POST" }); load(locId); }}>
                  {t("common.approve")}
                </button>
                <button className="btn danger small" onClick={async () => { await api(`/phone-links/${p.id}/reject`, { method: "POST" }); load(locId); }}>
                  {t("common.reject")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>{t("team.presence")}</h2>
        {roster.length === 0 && <div className="empty">—</div>}
        {roster.map((p) => (
          <div className="presence-row" key={p.id}>
            <div style={{ minWidth: 0 }}>
              <div className="presence-name">{p.name}</div>
              <div className="presence-times">
                {p.clock_in
                  ? <>
                      {t("team.in")} <b>{fmtTime(p.clock_in)}</b>
                      {p.clock_out ? <> · {t("team.out")} <b>{fmtTime(p.clock_out)}</b></> : null}
                      {p.sessions.length > 1 ? <> · {t("team.sessionsN", { n: p.sessions.length })}</> : null}
                    </>
                  : (p.shift || (p.job_title !== "—" ? p.job_title : ""))}
              </div>
            </div>
            <div className="presence-right">
              <span className={`pill ${p.status}`}>{t(`status.${p.status}`)}</span>
              {p.worked_min > 0 && <span className="presence-worked">{fmtMin(p.worked_min)}</span>}
            </div>
          </div>
        ))}
      </div>

      {actionItems.length > 0 && (
        <div className="card tinted">
          <h2>{t("team.pending")}</h2>
          {actionItems.map(([n, key], i) => (
            <div key={i} className="spread list-item">
              <span><strong>{n}</strong> {t(key)}</span>
              <Link className="btn small subtle" to="/approvals">{t("common.review")}</Link>
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
    </>
  );
}
