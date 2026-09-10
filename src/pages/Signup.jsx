import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, setToken } from "../api.js";
import { useAuth } from "../App.jsx";
import { useI18n, LangSwitch } from "../i18n.jsx";

// Self-serve clinic signup: one form → organization, location, checkpoint and
// admin account are provisioned server-side; lands straight in the setup guide.
export default function Signup() {
  const { adoptSession } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [form, setForm] = useState({ clinic_name: "", first_name: "", last_name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const d = await api("/orgs/signup", { method: "POST", body: form });
      setToken(d.token);
      adoptSession(d.user);
      navigate("/setup");
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="corner-lang"><LangSwitch /></div>
      <form className="card login-card" onSubmit={submit}>
        <div className="brand"><span className="brand-mark">T</span>TapTime</div>
        <h2 style={{ marginTop: 6 }}>{t("signup.title")}</h2>
        <p className="muted small">{t("signup.sub")}</p>
        <label className="field" style={{ textAlign: "left", marginTop: 12 }}>
          <span>{t("signup.clinic")}</span>
          <input value={form.clinic_name} onChange={set("clinic_name")} placeholder="Zâmbet Dental" required autoFocus />
        </label>
        <div className="grid2">
          <label className="field" style={{ textAlign: "left" }}>
            <span>{t("signup.first")}</span>
            <input value={form.first_name} onChange={set("first_name")} required />
          </label>
          <label className="field" style={{ textAlign: "left" }}>
            <span>{t("signup.last")}</span>
            <input value={form.last_name} onChange={set("last_name")} required />
          </label>
        </div>
        <label className="field" style={{ textAlign: "left" }}>
          <span>{t("common.email")}</span>
          <input type="email" value={form.email} onChange={set("email")} required />
        </label>
        <label className="field" style={{ textAlign: "left" }}>
          <span>{t("common.password")}</span>
          <input type="password" value={form.password} onChange={set("password")} minLength={6} required />
        </label>
        {error && <div className="error-box">{error}</div>}
        <button className="btn big" disabled={busy}>{busy ? t("signup.creating") : t("signup.create")}</button>
        <p className="small muted" style={{ marginTop: 16 }}>
          <Link to="/">{t("login.signin")}</Link>
        </p>
      </form>
    </div>
  );
}
