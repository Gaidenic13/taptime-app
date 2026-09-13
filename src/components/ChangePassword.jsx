import React, { useState } from "react";
import { api } from "../api.js";
import { useI18n } from "../i18n.jsx";

export default function ChangePassword() {
  const { t } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setError(""); setSaved(false);
    if (next !== confirm) { setError(t("security.passwordMismatch")); return; }
    setBusy(true);
    try { await api("/auth/password", { method: "PUT", body: { current_password: current, new_password: next } }); setCurrent(""); setNext(""); setConfirm(""); setSaved(true); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <form className="card" onSubmit={submit}>
    <h2>{t("security.changePassword")}</h2><p className="small muted">{t("security.changePasswordNote")}</p>
    <div className="grid3">
      <label className="field"><span>{t("security.currentPassword")}</span><input type="password" required minLength={6} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
      <label className="field"><span>{t("security.newPassword")}</span><input type="password" required minLength={6} maxLength={256} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
      <label className="field"><span>{t("security.confirmPassword")}</span><input type="password" required minLength={6} maxLength={256} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
    </div>
    <button className="btn small" disabled={busy}>{busy ? "…" : t("common.save")}</button>
    {error && <div className="error-box" role="alert">{error}</div>}
    {saved && <div className="ok-box" role="status">{t("set.saved")}</div>}
  </form>;
}
