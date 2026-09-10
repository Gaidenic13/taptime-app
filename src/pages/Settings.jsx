import React, { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, fmtDateTime, weekdayNames } from "../api.js";
import { useI18n } from "../i18n.jsx";

function QrImg({ url }) {
  const [src, setSrc] = useState("");
  useEffect(() => { QRCode.toDataURL(url, { width: 160, margin: 1 }).then(setSrc); }, [url]);
  return src ? <img className="qr-box" src={src} alt={`QR ${url}`} width={110} height={110} /> : null;
}

// ---------------------------------------------------------------- Rules
function Rules() {
  const { t } = useI18n();
  const [settings, setSettings] = useState(null);
  const [notice, setNotice] = useState("");
  useEffect(() => { api("/admin/settings").then((d) => setSettings(d.settings)); }, []);
  if (!settings) return null;

  const save = async (patch) => {
    const d = await api("/admin/settings", { method: "PUT", body: patch });
    setSettings(d.settings);
    setNotice(t("set.saved"));
    setTimeout(() => setNotice(""), 1500);
  };
  const num = (key, labelKey) => (
    <label className="field"><span>{t(labelKey)}</span>
      <input type="number" min="0" defaultValue={settings[key]}
        onBlur={(e) => Number(e.target.value) !== settings[key] && save({ [key]: Number(e.target.value) })} />
    </label>
  );

  return (
    <div className="card">
      <h2>{t("set.rulesTitle")}</h2>
      <p className="small muted">{t("set.rulesSub")}</p>
      {notice && <div className="ok-box">{notice}</div>}
      <div className="grid2" style={{ marginTop: 8 }}>
        {num("daily_goal_hours", "set.dailyGoal")}
        {num("clock_in_early_min", "set.earlyIn")}
        {num("late_grace_min", "set.grace")}
        {num("clock_in_late_flag_min", "set.lateFlag")}
        {num("overtime_threshold_min", "set.otThreshold")}
        {num("break_max_min", "set.breakMax")}
        <label className="field"><span>{t("set.locMode")}</span>
          <select value={settings.location_mode} onChange={(e) => save({ location_mode: e.target.value })}>
            <option value="required">{t("set.locRequired")}</option>
            <option value="preferred">{t("set.locPreferred")}</option>
            <option value="optional">{t("set.locOptional")}</option>
            <option value="disabled">{t("set.locDisabled")}</option>
          </select>
        </label>
        <label className="field"><span>{t("set.highRisk")}</span>
          <select value={settings.high_risk_action} onChange={(e) => save({ high_risk_action: e.target.value })}>
            <option value="review">{t("set.hrReview")}</option>
            <option value="flag">{t("set.hrFlag")}</option>
            <option value="accept">{t("set.hrAccept")}</option>
          </select>
        </label>
        <label className="field"><span>{t("set.reqShift")}</span>
          <select value={String(settings.require_shift_to_clock_in)}
            onChange={(e) => save({ require_shift_to_clock_in: e.target.value === "true" })}>
            <option value="false">{t("set.reqShiftNo")}</option>
            <option value="true">{t("set.reqShiftYes")}</option>
          </select>
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Staffing
function Staffing({ directory }) {
  const { t } = useI18n();
  const days = weekdayNames();
  const [reqs, setReqs] = useState([]);
  const [form, setForm] = useState({ weekday: 0, start_time: "08:00", end_time: "14:00", required_count: 1 });
  const [error, setError] = useState("");
  const load = () => api("/admin/staffing-requirements").then((d) => setReqs(d.requirements));
  useEffect(() => { load(); }, []);

  const add = async (e) => {
    e.preventDefault();
    setError("");
    try {
      await api("/admin/staffing-requirements", {
        method: "POST",
        body: {
          ...form,
          weekday: Number(form.weekday),
          location_id: Number(form.location_id || directory.locations[0]?.id),
          job_role_id: Number(form.job_role_id || directory.job_roles[0]?.id),
          required_count: Number(form.required_count),
        },
      });
      load();
    } catch (err) { setError(err.message); }
  };
  const remove = async (id) => { await api(`/admin/staffing-requirements/${id}`, { method: "DELETE" }); load(); };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const byDay = {};
  for (const r of reqs) (byDay[r.weekday] = byDay[r.weekday] || []).push(r);

  return (
    <>
      <form className="card" onSubmit={add}>
        <h2>{t("set.addReq")}</h2>
        <div className="grid3" style={{ marginTop: 8 }}>
          <label className="field"><span>{t("set.weekday")}</span>
            <select value={form.weekday} onChange={set("weekday")}>
              {days.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </label>
          <label className="field"><span>{t("common.location")}</span>
            <select value={form.location_id} onChange={set("location_id")}>
              {directory.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <label className="field"><span>{t("common.role")}</span>
            <select value={form.job_role_id} onChange={set("job_role_id")}>
              {directory.job_roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <label className="field"><span>{t("common.from")}</span><input type="time" value={form.start_time} onChange={set("start_time")} /></label>
          <label className="field"><span>{t("common.to")}</span><input type="time" value={form.end_time} onChange={set("end_time")} /></label>
          <label className="field"><span>{t("set.required")}</span><input type="number" min="1" value={form.required_count} onChange={set("required_count")} /></label>
        </div>
        {error && <div className="error-box">{error}</div>}
        <button className="btn">{t("set.addReqBtn")}</button>
      </form>
      {days.map((day, wd) => byDay[wd]?.length > 0 && (
        <div className="card" key={wd}>
          <h2>{day}</h2>
          {byDay[wd].map((r) => (
            <div className="list-item spread" key={r.id}>
              <span><strong>{r.required_count}× {r.role_name}</strong> <span className="muted">· {r.location_name} · {r.start_time}–{r.end_time}</span></span>
              <button className="btn subtle small" onClick={() => remove(r.id)}>{t("common.remove")}</button>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- Checkpoints & Kiosks
function Checkpoints({ directory, kind }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [name, setName] = useState("");
  const [locId, setLocId] = useState("");
  const [type, setType] = useState("QR");
  const [error, setError] = useState("");
  const load = () => api("/admin/checkpoints").then(setData);
  useEffect(() => { load(); }, []);
  if (!data) return null;

  const add = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const body = { name, location_id: Number(locId || directory.locations[0]?.id) };
      if (kind === "checkpoint") await api("/admin/checkpoints", { method: "POST", body: { ...body, type } });
      else await api("/admin/kiosks", { method: "POST", body });
      setName(""); load();
    } catch (err) { setError(err.message); }
  };
  const reset = async (id) => { await api(`/admin/kiosks/${id}/reset`, { method: "POST" }); load(); };
  const origin = window.location.origin;

  return (
    <>
      <form className="card" onSubmit={add}>
        <h2>{kind === "checkpoint" ? t("set.addCp") : t("set.addKiosk")}</h2>
        <div className="grid3" style={{ marginTop: 8 }}>
          <label className="field"><span>{t("common.name")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="field"><span>{t("common.location")}</span>
            <select value={locId} onChange={(e) => setLocId(e.target.value)}>
              {directory.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          {kind === "checkpoint" && (
            <label className="field"><span>{t("common.type")}</span>
              <select value={type} onChange={(e) => setType(e.target.value)}>
                <option>QR</option><option>NFC</option>
              </select>
            </label>
          )}
        </div>
        {error && <div className="error-box">{error}</div>}
        <button className="btn">{t("common.create")}</button>
      </form>

      {kind === "checkpoint" ? (
        <div className="card">
          <h2>{t("set.cpTitle")}</h2>
          <p className="small muted">{t("set.cpSub")}</p>
          {data.checkpoints.map((c) => (
            <div className="list-item spread" key={c.id}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div className="row">
                  <input
                    defaultValue={c.name}
                    style={{ maxWidth: 200, padding: "7px 10px", fontWeight: 600 }}
                    onBlur={async (e) => {
                      const name = e.target.value.trim();
                      if (name && name !== c.name) {
                        await api(`/admin/checkpoints/${c.id}`, { method: "PATCH", body: { name } });
                        load();
                      }
                    }}
                  />
                  <span className="pill no_shift">{c.type}</span>
                </div>
                <div className="small muted" style={{ marginTop: 6 }}>{c.location_name} · {origin}/checkpoint/{c.code}</div>
              </div>
              <QrImg url={`${origin}/checkpoint/${c.code}`} />
            </div>
          ))}
        </div>
      ) : (
        <div className="card">
          <h2>{t("set.kioskTitle")}</h2>
          <p className="small muted">{t("set.kioskSub", { url: `${origin}/terminal` })}</p>
          {data.kiosks.map((k) => (
            <div className="list-item spread" key={k.id}>
              <div>
                <strong>{k.name}</strong>{" "}
                {k.device_token
                  ? <span className="pill working">{t("set.registered")}</span>
                  : <span className="pill pending">{t("set.awaiting", { code: k.setup_code })}</span>}
                <div className="small muted">
                  {k.location_name}{k.last_seen_at ? ` · ${t("set.lastSeen", { time: fmtDateTime(k.last_seen_at) })}` : ""}
                </div>
              </div>
              <button className="btn subtle small" onClick={() => reset(k.id)}>{t("set.reset")}</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Roles & departments & locations
function RolesDepts({ directory, reload }) {
  const { t } = useI18n();
  const [role, setRole] = useState("");
  const [dept, setDept] = useState("");
  const add = (path, name, clear) => async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    await api(path, { method: "POST", body: { name: name.trim() } });
    clear(""); reload();
  };
  return (
    <div className="grid2">
      <form className="card" onSubmit={add("/admin/job-roles", role, setRole)}>
        <h2>{t("set.jobRoles")}</h2>
        <p className="small muted">{t("set.jobRolesSub")}</p>
        {directory.job_roles.map((r) => <div className="list-item" key={r.id}>{r.name}</div>)}
        <div className="row" style={{ marginTop: 10 }}>
          <input value={role} onChange={(e) => setRole(e.target.value)} placeholder={t("set.newRole")} style={{ flex: 1 }} />
          <button className="btn small">{t("common.add")}</button>
        </div>
      </form>
      <form className="card" onSubmit={add("/admin/departments", dept, setDept)}>
        <h2>{t("set.departments")}</h2>
        {directory.departments.map((d) => <div className="list-item" key={d.id}>{d.name}</div>)}
        <div className="row" style={{ marginTop: 10 }}>
          <input value={dept} onChange={(e) => setDept(e.target.value)} placeholder={t("set.newDept")} style={{ flex: 1 }} />
          <button className="btn small">{t("common.add")}</button>
        </div>
      </form>
    </div>
  );
}

function Locations({ directory, reload }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ name: "", address: "", latitude: "", longitude: "", attendance_radius_meters: 150 });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const add = async (e) => {
    e.preventDefault();
    await api("/admin/locations", {
      method: "POST",
      body: {
        ...form,
        latitude: form.latitude === "" ? null : Number(form.latitude),
        longitude: form.longitude === "" ? null : Number(form.longitude),
        attendance_radius_meters: Number(form.attendance_radius_meters),
      },
    });
    setForm({ name: "", address: "", latitude: "", longitude: "", attendance_radius_meters: 150 });
    reload();
  };
  return (
    <>
      <div className="card">
        <h2>{t("set.locTitle")}</h2>
        {directory.locations.map((l) => (
          <div className="list-item" key={l.id}>
            <strong>{l.name}</strong>
            <div className="small muted">
              {l.address || t("set.noAddress")} ·{" "}
              {l.latitude != null ? `${l.latitude.toFixed(4)}, ${l.longitude.toFixed(4)} (r=${l.attendance_radius_meters}m)` : t("set.noGeofence")}
            </div>
          </div>
        ))}
      </div>
      <form className="card" onSubmit={add}>
        <h2>{t("set.addLoc")}</h2>
        <div className="grid2" style={{ marginTop: 8 }}>
          <label className="field"><span>{t("common.name")}</span><input value={form.name} onChange={set("name")} required /></label>
          <label className="field"><span>{t("set.address")}</span><input value={form.address} onChange={set("address")} /></label>
          <label className="field"><span>Lat</span><input value={form.latitude} onChange={set("latitude")} placeholder="44.4531" /></label>
          <label className="field"><span>Lng</span><input value={form.longitude} onChange={set("longitude")} placeholder="26.0982" /></label>
          <label className="field"><span>{t("set.radius")}</span>
            <input type="number" min="30" value={form.attendance_radius_meters} onChange={set("attendance_radius_meters")} /></label>
        </div>
        <button className="btn">{t("set.addLoc")}</button>
      </form>
    </>
  );
}

// ---------------------------------------------------------------- Audit
function AuditLog() {
  const { t } = useI18n();
  const [entries, setEntries] = useState([]);
  useEffect(() => { api("/admin/audit").then((d) => setEntries(d.entries)); }, []);
  return (
    <div className="card table-wrap">
      <h2>{t("set.auditTitle")}</h2>
      <table>
        <thead>
          <tr>
            <th>{t("set.when")}</th><th>{t("set.actor")}</th><th>{t("set.action")}</th>
            <th>{t("set.entity")}</th><th>{t("set.change")}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="small">{fmtDateTime(e.created_at)}</td>
              <td>{e.first_name ? `${e.first_name} ${e.last_name}` : t("set.system")}</td>
              <td><strong>{e.action}</strong></td>
              <td className="small">{e.entity_type}{e.entity_id ? ` #${e.entity_id}` : ""}</td>
              <td className="small muted" style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.new_value || e.metadata || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Settings() {
  const { t } = useI18n();
  const [tab, setTab] = useState("rules");
  const [directory, setDirectory] = useState(null);
  const loadDir = () => api("/directory").then(setDirectory);
  useEffect(() => { loadDir(); }, []);
  if (!directory) return null;

  const TABS = [
    ["rules", "set.rules"], ["staffing", "set.staffing"], ["checkpoints", "set.checkpoints"],
    ["kiosks", "set.kiosks"], ["rolesDepts", "set.rolesDepts"], ["locations", "set.locations"],
    ["audit", "set.audit"],
  ];

  return (
    <>
      <div className="page-head">
        <h1>{t("set.title")}</h1>
        <p>{t("set.sub")}</p>
      </div>
      <div className="tabs">
        {TABS.map(([k, key]) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{t(key)}</button>
        ))}
      </div>
      {tab === "rules" && <Rules />}
      {tab === "staffing" && <Staffing directory={directory} />}
      {tab === "checkpoints" && <Checkpoints directory={directory} kind="checkpoint" />}
      {tab === "kiosks" && <Checkpoints directory={directory} kind="kiosk" />}
      {tab === "rolesDepts" && <RolesDepts directory={directory} reload={loadDir} />}
      {tab === "locations" && <Locations directory={directory} reload={loadDir} />}
      {tab === "audit" && <AuditLog />}
    </>
  );
}
