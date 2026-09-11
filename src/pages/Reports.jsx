import React, { useEffect, useState } from "react";
import { downloadCsv } from "../csv.js";
import { api, fmtMin, fmtDate, fmtMonth } from "../api.js";
import { useI18n } from "../i18n.jsx";

const monthStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const shiftMonth = (month, delta) => {
  const [y, m] = month.split("-").map(Number);
  return monthStr(new Date(y, m - 1 + delta, 1));
};


function AttendanceTab() {
  const { t } = useI18n();
  const [month, setMonth] = useState(monthStr());
  const [locationId, setLocationId] = useState("");
  const [jobRoleId, setJobRoleId] = useState("");
  const [directory, setDirectory] = useState(null);
  const [data, setData] = useState(null);

  useEffect(() => { api("/directory").then(setDirectory); }, []);
  useEffect(() => {
    const params = new URLSearchParams({ month });
    if (locationId) params.set("location_id", locationId);
    if (jobRoleId) params.set("job_role_id", jobRoleId);
    api(`/reports/monthly?${params}`).then(setData);
  }, [month, locationId, jobRoleId]);

  if (!data || !directory) return null;
  const totals = data.rows.reduce(
    (acc, r) => ({
      scheduled: acc.scheduled + r.scheduled_min, worked: acc.worked + r.worked_min,
      overtime: acc.overtime + r.overtime_min, leave: acc.leave + r.leave_days,
    }),
    { scheduled: 0, worked: 0, overtime: 0, leave: 0 }
  );

  const csv = () => downloadCsv(
    `taptime-attendance-${month}.csv`,
    ["common.employee", "common.role", "csv.scheduled", "csv.worked", "csv.breaks", "csv.missing", "csv.overtime", "rep.leaveDays", "rep.late", "rep.absentH", "rep.forgot"].map((key) => t(key)),
    data.rows.map((r) => [r.name, r.job_title,
      (r.scheduled_min / 60).toFixed(2), (r.worked_min / 60).toFixed(2), (r.break_min / 60).toFixed(2),
      (r.missing_min / 60).toFixed(2), (r.overtime_min / 60).toFixed(2),
      r.leave_days, r.late_days, r.absent_days, r.forgot_out])
  );

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)} style={{ width: "auto" }}>
          <option value="">{t("sched.allLocations")}</option>
          {directory.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select value={jobRoleId} onChange={(e) => setJobRoleId(e.target.value)} style={{ width: "auto" }}>
          <option value="">{t("sched.allRoles")}</option>
          {directory.job_roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button className="btn subtle small" onClick={() => setMonth(shiftMonth(month, -1))}>←</button>
        <strong>{fmtMonth(month)}</strong>
        <button className="btn subtle small" onClick={() => setMonth(shiftMonth(month, 1))}>→</button>
        <button className="btn small" onClick={csv}>{t("common.export")}</button>
      </div>

      <div className="stats">
        <div className="stat hl"><div className="n">{fmtMin(totals.worked)}</div><div className="l">{t("rep.totalWorked")}</div></div>
        <div className="stat"><div className="n">{fmtMin(totals.scheduled)}</div><div className="l">{t("rep.totalScheduled")}</div></div>
        <div className="stat"><div className="n">{fmtMin(totals.overtime)}</div><div className="l">{t("rep.approvedOt")}</div></div>
        <div className="stat"><div className="n">{totals.leave}</div><div className="l">{t("rep.leaveDays")}</div></div>
      </div>

      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("common.employee")}</th><th>{t("common.role")}</th><th>{t("common.scheduled")}</th>
              <th>{t("common.worked")}</th><th>{t("common.breaks")}</th><th>{t("rep.missing")}</th>
              <th>{t("rep.ot")}</th><th>{t("rep.leave")}</th><th>{t("rep.late")}</th><th>{t("rep.absentH")}</th><th>{t("rep.forgot")}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.name}</strong></td>
                <td className="small">{r.job_title}</td>
                <td>{fmtMin(r.scheduled_min)}</td>
                <td><strong>{fmtMin(r.worked_min)}</strong></td>
                <td>{r.break_min ? fmtMin(r.break_min) : "—"}</td>
                <td style={r.missing_min > 120 ? { color: "var(--red)", fontWeight: 600 } : {}}>{fmtMin(r.missing_min)}</td>
                <td>{r.overtime_min ? fmtMin(r.overtime_min) : "—"}</td>
                <td>{r.leave_days || "—"}</td>
                <td style={r.late_days > 2 ? { color: "var(--amber)", fontWeight: 600 } : {}}>{r.late_days || "—"}</td>
                <td style={r.absent_days > 0 ? { color: "var(--red)", fontWeight: 600 } : {}}>{r.absent_days || "—"}</td>
                <td style={r.forgot_out > 0 ? { color: "var(--red)", fontWeight: 600 } : {}}>{r.forgot_out || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function LeaveTab() {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  useEffect(() => { api("/reports/leave").then(setData); }, []);
  if (!data) return null;

  const csv = () => downloadCsv(
    `taptime-leave-${data.year}.csv`,
    ["common.employee", "common.role", "emp.department", "rep.used", "rep.remaining"].map((key) => t(key)),
    data.rows.map((r) => [r.name, r.job_title, r.department, r.used, r.remaining])
  );

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <strong>{t("rep.leaveUsage", { year: data.year })}</strong>
        <button className="btn small" onClick={csv}>{t("common.export")}</button>
      </div>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("common.employee")}</th><th>{t("common.role")}</th><th>{t("emp.department")}</th>
              <th>{t("rep.used")}</th><th>{t("rep.remaining")}</th><th>{t("rep.byType")}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.name}</strong></td>
                <td className="small">{r.job_title}</td>
                <td className="small">{r.department}</td>
                <td><strong>{r.used}</strong>d</td>
                <td>{r.remaining}d</td>
                <td className="small muted">
                  {Object.entries(r.by_type).map(([k, d]) => `${t(`leave.${k}`)}: ${d}d`).join(" · ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function StaffingTab() {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  useEffect(() => { api("/reports/staffing").then(setData); }, []);
  if (!data) return null;
  const gaps = data.rows.filter((r) => r.gap > 0);
  const csv = () => downloadCsv(`taptime-staffing-${data.start}.csv`,
    ["common.date", "common.location", "common.role", "rep.band", "rep.required", "common.scheduled", "rep.gap"].map((key) => t(key)),
    data.rows.map((r) => [r.date, r.location, r.role, r.band, r.required, r.scheduled, r.gap]));

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <strong>{t("rep.coverage", { a: fmtDate(data.start), b: fmtDate(data.end) })}</strong>
        <button className="btn small" onClick={csv}>{t("common.export")}</button>
        {gaps.length > 0
          ? <span className="pill late">{t("rep.gaps", { n: gaps.length })}</span>
          : <span className="pill working">{t("rep.covered")}</span>}
      </div>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("common.date")}</th><th>{t("common.location")}</th><th>{t("common.role")}</th>
              <th>{t("rep.band")}</th><th>{t("rep.required")}</th><th>{t("common.scheduled")}</th><th>{t("rep.gap")}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => (
              <tr key={i} style={r.gap > 0 ? { background: "var(--red-soft)" } : {}}>
                <td><strong>{fmtDate(r.date)}</strong></td>
                <td>{r.location}</td>
                <td>{r.role}</td>
                <td>{r.band}</td>
                <td>{r.required}</td>
                <td>{r.scheduled}</td>
                <td style={r.gap > 0 ? { color: "var(--red)", fontWeight: 600 } : {}}>{r.gap || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function Reports() {
  const { t } = useI18n();
  const [tab, setTab] = useState("attendance");
  const tabs = [["attendance", "rep.attendance"], ["leave", "rep.leave"], ["staffing", "rep.staffing"]];
  return (
    <>
      <div className="page-head">
        <h1>{t("rep.title")}</h1>
        <p>{t("rep.sub")}</p>
      </div>
      <div className="tabs">
        {tabs.map(([k, key]) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{t(key)}</button>
        ))}
      </div>
      {tab === "attendance" && <AttendanceTab />}
      {tab === "leave" && <LeaveTab />}
      {tab === "staffing" && <StaffingTab />}
    </>
  );
}
