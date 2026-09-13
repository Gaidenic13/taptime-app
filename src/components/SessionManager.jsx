import React, { useEffect, useState } from "react";
import { api, fmtDateTime } from "../api.js";
import { useAuth } from "../App.jsx";
import { useI18n } from "../i18n.jsx";

export default function SessionManager() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState("");
  const load = () => api("/admin/sessions").then((d) => setSessions(d.sessions)).catch((e) => setError(e.message));
  useEffect(load, []);
  const revoke = async (id) => {
    if (!window.confirm(t("security.revokeConfirm"))) return;
    try { await api(`/admin/sessions/${id}`, { method: "DELETE" }); load(); }
    catch (e) { setError(e.message); }
  };
  return <div className="card">
    <h2>{t("security.sessions")}</h2>
    <p className="small muted">{t("security.sessionsNote")}</p>
    {error && <div className="error-box">{error}</div>}
    {!sessions && !error && <p>{t("common.loading")}</p>}
    {sessions?.length === 0 && <p>{t("security.noSessions")}</p>}
    {sessions?.map((s) => <div className="list-item spread" key={`${s.user_id}-${s.created_at}`}>
      <div><strong>{s.first_name} {s.last_name}</strong><div className="small muted">{s.email} · {s.role}</div>
        <div className="small muted">{t("security.lastSeen")}: {fmtDateTime(s.last_seen_at || s.created_at)} · {s.user_agent || t("security.unknownDevice")}</div></div>
      <div className="row">{s.current && <span className="pill working">{t("security.current")}</span>}
        {!s.current && <button className="btn ghost small" onClick={() => revoke(s.user_id)}>{t("security.revoke")}</button>}</div>
    </div>)}
  </div>;
}
