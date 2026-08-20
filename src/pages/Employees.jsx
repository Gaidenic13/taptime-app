import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../App.jsx";
import { useI18n } from "../i18n.jsx";

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
          <label className="field"><span>{t("common.email")}</span>
            <input type="email" value={form.email} onChange={set("email")} required />
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
  const [directory, setDirectory] = useState(null);
  const [modal, setModal] = useState(undefined);

  const load = () => api("/employees").then((d) => setEmployees(d.employees));
  useEffect(() => {
    load();
    api("/directory").then(setDirectory);
  }, []);

  const toggleActive = async (emp) => {
    await api(`/employees/${emp.id}`, { method: "PATCH", body: { active: emp.active ? 0 : 1 } });
    load();
  };

  return (
    <>
      <div className="page-head spread">
        <div>
          <h1>{t("emp.title")}</h1>
          <p>{t("emp.active", { n: employees.filter((e) => e.active).length })}</p>
        </div>
        {isAdmin && directory && <button className="btn" onClick={() => setModal(null)}>+ {t("emp.add")}</button>}
      </div>

      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("common.name")}</th><th>{t("emp.jobRole")}</th><th>{t("emp.department")}</th>
              <th>{t("common.location")}</th><th>{t("common.email")}</th><th>{t("emp.leaveLeft")}</th>
              <th>{t("emp.access")}</th>{isAdmin && <th></th>}
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id} style={e.active ? {} : { opacity: 0.45 }}>
                <td><strong>{e.first_name} {e.last_name}</strong></td>
                <td>{e.job_title || "—"}</td>
                <td>{e.department_name || "—"}</td>
                <td>{e.location_name || "—"}</td>
                <td className="small">{e.email}</td>
                <td>{e.leave_balance}d</td>
                <td><span className={`pill ${e.role === "employee" ? "no_shift" : "leave"}`}>{e.role}</span></td>
                {isAdmin && (
                  <td>
                    <div className="row">
                      <button className="btn subtle small" onClick={() => setModal(e)}>{t("common.edit")}</button>
                      <button className="btn ghost small" onClick={() => toggleActive(e)}>
                        {e.active ? t("emp.deactivate") : t("emp.reactivate")}
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal !== undefined && directory && (
        <EmployeeModal
          employee={modal}
          directory={directory}
          onClose={() => setModal(undefined)}
          onDone={() => { setModal(undefined); load(); }}
        />
      )}
    </>
  );
}
