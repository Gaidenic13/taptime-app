import React, { useEffect, useState } from "react";
import { useI18n } from "../i18n.jsx";

export default function Credentials({ account, onSave }) {
  const { t } = useI18n();
  const [email, setEmail] = useState(account.email || "");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { setEmail(account.email || ""); }, [account.email]);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(""); setSaved(false);
    try { await onSave({ email, password }); setPassword(""); setShow(false); setSaved(true); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <form onSubmit={submit} className="list-item">
    <strong>{account.first_name} {account.last_name}</strong>
    <p className="small muted">{t(account.password_set ? "cred.set" : "cred.unset")}</p>
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="grid2">
        <label className="field"><span>{t("common.email")}</span>
          <input type="email" autoComplete="off" required value={email} onChange={(e) => { setEmail(e.target.value); setSaved(false); }} />
        </label>
        <label className="field"><span>{t("cred.newPassword")}</span>
          <input type={show ? "text" : "password"} autoComplete="new-password" minLength={6} maxLength={256} value={password} onChange={(e) => { setPassword(e.target.value); setSaved(false); }} placeholder={t("cred.keep")} />
        </label>
      </div>
      <div className="row">
        <button type="button" className="btn subtle small" onClick={() => setShow(!show)}>{t(show ? "cred.hide" : "cred.show")}</button>
        <button className="btn small" disabled={busy || (email === (account.email || "") && !password)}>{busy ? "…" : t("common.save")}</button>
      </div>
    </fieldset>
    {error && <div className="error-box" role="alert">{error}</div>}
    {saved && <div className="ok-box" role="status">{t("set.saved")}</div>}
  </form>;
}
