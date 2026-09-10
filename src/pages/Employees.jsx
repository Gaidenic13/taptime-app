import React, { useEffect, useState } from "react";
import { api, fmtMin, fmtTime, fmtDate, fmtMonth } from "../api.js";
import { useAuth } from "../App.jsx";
import { useI18n } from "../i18n.jsx";

const monthStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const shiftMonth = (month, delta) => {
  const [y, m] = month.split("-").map(Number);
  return monthStr(new Date(y, m - 1 + delta, 1));
};

// All entries (check-in/out sessions) of one person, month by month.
function EntriesModal({ employee, onClose }) {
  const { t } = useI18n();
  const [month, setMonth] = useState(monthStr());
  const [data, setData] = useState(null);

  useEffect(() => {
    api(`/attendance/history?user_id=${employee.id}&month=${month}`).then(setData);
  }, [employee.id, month]);

  const days = (data?.days || []).filter((d) => d.sessions?.length || d.leave);
  const total = days.reduce((s, d) => s + (d.worked_min || 0), 0);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="card modal-card" onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 100%)" }}>
        <div className="spread">
          <h2>{t("emp.entriesOf", { name: `${employee.first_name} ${employee.last_name}` })}</h2>
          <button className="btn subtle small" onClick={onClose}>✕</button>
        </div>
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="btn subtle small" onClick={() => setMonth(shiftMonth(month, -1))}>←</button>
          <strong>{fmtMonth(month)}</strong>
          <button className="btn subtle small" onClick={() => setMonth(shiftMonth(month, 1))}>→</button>
          <span className="pill working">{t("att.workedMonth")}: {fmtMin(total)}</span>
        </div>
        {days.length === 0 && <div className="empty">{t("emp.noEntries")}</div>}
        {days.map((d) => (
          <div className="list-item spread" key={d.date}>
            <strong>{fmtDate(d.date)}</strong>
            <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
              {d.leave && <span className="pill leave">{t(`leave.${d.leave.type}`)}</span>}
              {(d.sessions || []).map((s, i) => (
                <span key={i} className={`pill ${s.clock_out ? "no_shift" : "working"}`}>
                  {fmtTime(s.clock_in)} → {s.clock_out ? fmtTime(s.clock_out) : "…"}
                  {s.device_id ? ` · #${s.device_id}` : ""}
                </span>
              ))}
              {d.worked_min > 0 && <strong>{fmtMin(d.worked_min)}</strong>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmployeeModal({ employee, directory, onClose, onDone }) {
  const { t } = useI18n();
  const editing = !!employee;
  const [form, setForm] = useState({
    first_name: employee?.first_name || "",
    last_name: employee?.last_name || "",
    email: employee?.email || "",
    phone: employee?.phone || "",
    job_role_id: employee?.job_role_id || directory.job_roles[0]?.id || "",
    department_id: employee?.department_id || "",
    role: employee?.role || "employee",
    location_id: employee?.location_id || directory.locations[0]?.id || "",
    pin: employee?.pin || "",
    leave_balance: employee?.leave_balance ?? 21,
  });
  const [error, setError] = useState("");
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    try {
      const body = {
        ...form,
        job_role_id: Number(form.job_role_id) || null,
        department_id: Number(form.department_id) || null,
        location_id: Number(form.location_id) || null,
        leave_balance: Number(form.leave_balance),
      };
      if (editing) {
        delete body.email; // email is the login identity; not editable here
        await api(`/employees/${employee.id}`, { method: "PATCH", body });
      } else {
        await api("/employees", { method: "POST", body });
      }
      onDone();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="card modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{editing ? t("emp.editTitle", { name: employee.first_name }) : t("emp.add")}</h2>
        <div className="grid2">
          <label className="field"><span>{t("emp.first")}</span>
            <input value={form.first_name} onChange={set("first_name")} required />
          </label>
          <label className="field"><span>{t("emp.last")}</span>
            <input value={form.last_name} onChange={set("last_name")} required />
          </label>
        </div>
        {!editing && (
          <label className="field"><span>{t("emp.emailOpt")}</span>
            <input type="email" value={form.email} onChange={set("email")} required={form.role !== "employee"} />
          </label>
        )}
        <div className="grid2">
          <label className="field"><span>{t("emp.phone")}</span>
            <input value={form.phone} onChange={set("phone")} />
          </label>
          <label className="field"><span>{t("emp.pin")}</span>
            <input value={form.pin} onChange={set("pin")} pattern="\d{4}" placeholder="4321" />
          </label>
        </div>
        <div className="grid2">
          <label className="field"><span>{t("emp.jobRole")}</span>
            <select value={form.job_role_id} onChange={set("job_role_id")}>
              {directory.job_roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <label className="field"><span>{t("emp.department")}</span>
            <select value={form.department_id} onChange={set("department_id")}>
              <option value="">—</option>
              {directory.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        </div>
        <div className="grid2">
          <label className="field"><span>{t("emp.appAccess")}</span>
            <select value={form.role} onChange={set("role")}>
              <option value="employee">{t("emp.rEmployee")}</option>
              <option value="manager">{t("emp.rManager")}</option>
              <option value="admin">{t("emp.rAdmin")}</option>
            </select>
          </label>
          <label className="field"><span>{t("emp.primaryLoc")}</span>
            <select value={form.location_id} onChange={set("location_id")}>
              {directory.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        </div>
        <label className="field"><span>{t("emp.balanceDays")}</span>
          <input type="number" min="0" step="0.5" value={form.leave_balance} onChange={set("leave_balance")} />
        </label>
        {!editing && <p className="small muted">{t("emp.pwNote")}</p>}
        {error && <div className="error-box">{error}</div>}
        <div className="row">
          <button className="btn" type="submit">{editing ? t("emp.saveChanges") : t("emp.createInvite")}</button>
          <button className="btn subtle" type="button" onClick={onClose}>{t("common.cancel")}</button>
        </div>
      </form>
    </div>
  );
}

export default function Employees() {
  const { user } = useAuth();
  const { t } = useI18n();
  const isAdmin = user.role === "admin" || user.role === "owner";
  const [employees, setEmployees] = useState([]);
  const [forgot, setForgot] = useState({});
  const [directory, setDirectory] = useState(null);
  const [modal, setModal] = useState(undefined);
  const [entriesFor, setEntriesFor] = useState(null);
  const [qFirst, setQFirst] = useState("");
  const [qLast, setQLast] = useState("");
  const [justAdded, setJustAdded] = useState(null);
  const [error, setError] = useState("");

  const load = () => api("/employees").then((d) => { setEmployees(d.employees); setForgot(d.forgot_out_month || {}); });
  useEffect(() => {
    load();
    api("/directory").then(setDirectory);
  }, []);

  const quickAdd = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const d = await api("/employees/quick", { method: "POST", body: { first_name: qFirst, last_name: qLast } });
      setJustAdded({ name: `${qFirst} ${qLast}`.trim() });
      setQFirst(""); setQLast("");
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  // Lost/stolen phone: nothing scans for them until a new link is approved.
  const unlinkPhone = async (emp) => {
    if (!window.confirm(t("emp.unlinkConfirm", { name: emp.first_name }))) return;
    await api(`/employees/${emp.id}/unlink-phone`, { method: "POST" });
    load();
  };

  const toggleActive = async (emp) => {
    await api(`/employees/${emp.id}`, { method: "PATCH", body: { active: emp.active ? 0 : 1 } });
    load();
  };

  return (
    <>
      <div className="page-head">
        <h1>{t("emp.title")}</h1>
        <p>{t("emp.active", { n: employees.filter((e) => e.active).length })}</p>
      </div>

      {/* Adding someone is just a name — everything else is optional detail
          reachable later through Edit. */}
      {isAdmin && (
        <div className="card">
          <form className="row" onSubmit={quickAdd}>
            <input value={qFirst} onChange={(e) => setQFirst(e.target.value)} placeholder={t("emp.first")} required style={{ flex: 1, minWidth: 110 }} />
            <input value={qLast} onChange={(e) => setQLast(e.target.value)} placeholder={t("emp.last")} style={{ flex: 1, minWidth: 110 }} />
            <button className="btn">{t("setup.addBtn")}</button>
          </form>
          <p className="small muted" style={{ marginTop: 8 }}>{t("emp.quickAdd")}</p>
          {error && <div className="error-box">{error}</div>}
          {justAdded && (
            <div className="ok-box">{t("setup.added", { name: justAdded.name })}</div>
          )}
        </div>
      )}

      <div className="card">
        {employees.length === 0 && <div className="empty">—</div>}
        {employees.map((e) => (
          <div className="person-row" key={e.id} style={e.active ? {} : { opacity: 0.45 }}>
            <div className="person-main">
              <strong>
                {e.first_name} {e.last_name}
                {e.employment_status === "pending" && <span className="pill pending" style={{ marginLeft: 8 }}>{t("status.pending")}</span>}
              </strong>
              <div className="small muted">
                {[
                  e.role !== "employee" ? t(`emp.r${e.role === "admin" ? "Admin" : "Manager"}`) : (e.job_title && e.job_title !== "—" ? e.job_title : null),
                  e.role === "employee" ? t(e.phone_linked ? "emp.phoneLinked" : "emp.noPhone") : null,
                ].filter(Boolean).join(" · ")}
                {forgot[e.id] > 0 && (
                  <span style={{ color: "var(--red)", fontWeight: 600 }}> · {t("miss.forgotN", { n: forgot[e.id] })}</span>
                )}
              </div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn subtle small" onClick={() => setEntriesFor(e)}>{t("emp.entries")}</button>
              {isAdmin && e.phone_linked && (
                <button className="btn ghost small" onClick={() => unlinkPhone(e)}>{t("emp.unlinkPhone")}</button>
              )}
              {isAdmin && (
                <button className="btn ghost small" onClick={() => setModal(e)}>{t("common.edit")}</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {modal !== undefined && directory && (
        <EmployeeModal
          employee={modal}
          directory={directory}
          onClose={() => setModal(undefined)}
          onDone={() => { setModal(undefined); load(); }}
        />
      )}
      {entriesFor && <EntriesModal employee={entriesFor} onClose={() => setEntriesFor(null)} />}
    </>
  );
}
