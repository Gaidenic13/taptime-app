import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../App.jsx";
import { useI18n } from "../i18n.jsx";

export default function ClinicProfile() {
  const { t } = useI18n();
  const { user, adoptSession } = useAuth();
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const load = () => { setError(""); api("/admin/profile").then((d) => setProfile(d.profile)).catch((e) => setError(e.message)); };
  useEffect(load, []);
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setError(""); setSaved(false);
    try {
      const { profile: p } = await api("/admin/profile", { method: "PUT", body: profile });
      setProfile(p);
      adoptSession({ ...user, first_name: p.first_name, last_name: p.last_name, phone: p.phone, clinic: p.clinic_name });
      setSaved(true);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <form className="card" onSubmit={save}>
    <h2>{t("profile.title")}</h2><p className="small muted">{t("profile.note")}</p>
    {!profile && !error && <p>{t("common.loading")}</p>}
    {profile && <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
      <div className="grid2">
        {[["clinic_name", "signup.clinic", 120], ["first_name", "signup.first", 80], ["last_name", "signup.last", 80], ["phone", "profile.phone", 40]].map(([key, label, max]) =>
          <label className="field" key={key}><span>{t(label)}</span><input type={key === "phone" ? "tel" : "text"} value={profile[key]} maxLength={max} required={key !== "phone"} onChange={(e) => { setProfile({ ...profile, [key]: e.target.value }); setSaved(false); }} /></label>)}
      </div>
      <button className="btn small" disabled={busy}>{busy ? "…" : t("common.save")}</button>
    </fieldset>}
    {error && <div className="error-box" role="alert">{error} {!profile && <button type="button" className="btn subtle small" onClick={load}>{t("common.retry")}</button>}</div>}
    {saved && <div className="ok-box" role="status">{t("set.saved")}</div>}
  </form>;
}
