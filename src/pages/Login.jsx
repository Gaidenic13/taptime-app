import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../App.jsx";
import { useI18n, LangSwitch } from "../i18n.jsx";

export default function Login() {
  const { login } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="corner-lang"><LangSwitch /></div>
      <form className="card login-card" onSubmit={submit}>
        <div className="brand"><span className="brand-mark">T</span>TapTime</div>
        <p className="muted">{t("login.tagline")}</p>
        <label className="field" style={{ textAlign: "left", marginTop: 14 }}>
          <span>{t("common.email")}</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@clinic.com" required autoFocus />
        </label>
        <label className="field" style={{ textAlign: "left" }}>
          <span>{t("common.password")}</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
        </label>
        {error && <div className="error-box">{error}</div>}
        <button className="btn big" disabled={busy}>{busy ? t("login.signingin") : t("login.signin")}</button>
        <p className="small muted" style={{ marginTop: 12 }}>{t("login.membersNote")}</p>
        <p className="small muted" style={{ marginTop: 18 }}>
          {t("login.new")} <Link to="/signup">{t("login.signup")}</Link>
        </p>
        <p className="small muted" style={{ marginTop: 6 }}>
          {t("login.shared")} <Link to="/terminal">{t("login.terminal")}</Link>
        </p>
      </form>
    </div>
  );
}
