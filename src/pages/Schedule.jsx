import React, { useEffect, useState } from "react";
import { api, fmtDate } from "../api.js";
import { useAuth } from "../App.jsx";
import { useI18n } from "../i18n.jsx";

const DAY_MS = 86400000;
function mondayOf(d = new Date()) {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}
const addDays = (str, n) =>
  new Date(new Date(str + "T12:00:00").getTime() + n * DAY_MS).toISOString().slice(0, 10);

function ShiftModal({ employees, locations, date, onClose, onDone }) {
  const { t } = useI18n();
  const [userId, setUserId] = useState(employees[0]?.id || "");
  const [start, setStart] = useState("08:00");
  const [end, setEnd] = useState("16:00");
  const [loc, setLoc] = useState(locations[0]?.id || "");
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    try {
      await api("/schedule", {
        method: "POST",
        body: { user_id: Number(userId), date, start_time: start, end_time: end, location_id: Number(loc) },
      });
      onDone();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="card modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{t("sched.new", { date: fmtDate(date) })}</h2>
        <label className="field"><span>{t("common.employee")}</span>
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            {employees.map((u) => (
              <option key={u.id} value={u.id}>{u.first_name} {u.last_name} — {u.job_title}</option>
            ))}
          </select>
        </label>
        <div className="grid2">
          <label className="field"><span>{t("sched.start")}</span>
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
          </label>
          <label className="field"><span>{t("sched.end")}</span>
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
          </label>
        </div>
        <label className="field"><span>{t("common.location")}</span>
          <select value={loc} onChange={(e) => setLoc(e.target.value)}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        {error && <div className="error-box">{error}</div>}
        <div className="row">
          <button className="btn" type="submit">{t("sched.save")}</button>
          <button className="btn subtle" type="button" onClick={onClose}>{t("common.cancel")}</button>
        </div>
      </form>
    </div>
  );
}

export default function Schedule() {
  const { user } = useAuth();
  const { t } = useI18n();
  const isManager = user.role !== "employee";
  const [week, setWeek] = useState(mondayOf());
  const [view, setView] = useState("mine");
  const [data, setData] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [jobRoles, setJobRoles] = useState([]);
  const [filterLoc, setFilterLoc] = useState("");
  const [filterRole, setFilterRole] = useState("");
  const [adding, setAdding] = useState(null);

  const load = () => {
    const params = new URLSearchParams({ week });
    if (view === "team") {
      params.set("all", "1");
      if (filterLoc) params.set("location_id", filterLoc);
      if (filterRole) params.set("job_role_id", filterRole);
    }
    return api(`/schedule?${params}`).then(setData);
  };

  useEffect(() => { load(); }, [week, view, filterLoc, filterRole]);
  useEffect(() => {
    api("/directory").then((d) => { setLocations(d.locations); setJobRoles(d.job_roles); });
    if (isManager) api("/employees").then((d) => setEmployees(d.employees.filter((e) => e.active)));
  }, [isManager]);

  if (!data) return null;
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const today = new Date().toISOString().slice(0, 10);

  const remove = async (id) => {
    await api(`/schedule/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <>
      <div className="page-head spread">
        <div>
          <h1>{t("sched.title")}</h1>
          <p>{t("sched.weekOf", { date: fmtDate(week) })}</p>
        </div>
        <div className="row">
          {isManager && (
            <div className="seg">
              <button className={view === "mine" ? "active" : ""} onClick={() => setView("mine")}>{t("sched.mine")}</button>
              <button className={view === "team" ? "active" : ""} onClick={() => setView("team")}>{t("sched.team")}</button>
            </div>
          )}
          <button className="btn subtle small" onClick={() => setWeek(addDays(week, -7))}>←</button>
          <button className="btn subtle small" onClick={() => setWeek(mondayOf())}>{t("common.today")}</button>
          <button className="btn subtle small" onClick={() => setWeek(addDays(week, 7))}>→</button>
        </div>
      </div>

      {isManager && view === "team" && (
        <div className="row" style={{ marginBottom: 12 }}>
          <select value={filterLoc} onChange={(e) => setFilterLoc(e.target.value)} style={{ width: "auto" }}>
            <option value="">{t("sched.allLocations")}</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <select value={filterRole} onChange={(e) => setFilterRole(e.target.value)} style={{ width: "auto" }}>
            <option value="">{t("sched.allRoles")}</option>
            {jobRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
      )}

      <div className="card table-wrap">
        <div className="week-grid">
          {days.map((d) => (
            <div className="week-col" key={d}>
              <h4 className={d === today ? "today" : ""}>{fmtDate(d)}</h4>
              {data.shifts.filter((s) => s.date === d).map((s) => (
                <div className={`shift-chip ${s.user_id === user.id ? "mine" : ""}`} key={s.id}>
                  {view === "team" && <div className="who">{s.first_name} {s.last_name}</div>}
                  {s.start_time}–{s.end_time}
                  <div className="muted">{s.location_name || ""}</div>
                  {isManager && view === "team" && (
                    <button className="x" title={t("sched.delete")} onClick={() => remove(s.id)}>✕</button>
                  )}
                </div>
              ))}
              {isManager && view === "team" && (
                <button className="btn subtle small" style={{ width: "100%" }} onClick={() => setAdding(d)}>
                  + {t("common.add")}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {adding && (
        <ShiftModal
          employees={employees}
          locations={locations}
          date={adding}
          onClose={() => setAdding(null)}
          onDone={() => { setAdding(null); load(); }}
        />
      )}
    </>
  );
}
