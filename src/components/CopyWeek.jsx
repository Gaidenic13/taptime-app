import React, { useState } from "react";
import { api, fmtDate } from "../api.js";
import { useI18n } from "../i18n.jsx";

export default function CopyWeek({ sourceWeek, targetWeek, locationId, jobRoleId, onClose, onDone }) {
  const { t } = useI18n();
  const [target, setTarget] = useState(targetWeek);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = async (apply) => {
    setBusy(true); setError("");
    try {
      const d = await api("/schedule/copy-week", { method: "POST", body: {
        source_week: sourceWeek, target_week: target, apply,
        location_id: Number(locationId) || null, job_role_id: Number(jobRoleId) || null,
      } });
      if (d.applied) onDone(target, d.created);
      else setPreview(d);
    } catch (e) { setError(e.message); setPreview(null); }
    finally { setBusy(false); }
  };
  return <div className="modal-overlay">
    <form className="card modal-card" role="dialog" aria-modal="true" aria-labelledby="copy-week-title" onSubmit={(e) => { e.preventDefault(); request(false); }}>
      <h2 id="copy-week-title">{t("copy.title")}</h2>
      <p className="small muted">{t("copy.note", { date: fmtDate(sourceWeek) })}</p>
      <label className="field"><span>{t("copy.target")}</span>
        <input type="date" required value={target} disabled={busy} onChange={(e) => { setTarget(e.target.value); setPreview(null); }} />
      </label>
      <button className="btn subtle small" disabled={busy}>{busy ? "…" : t("copy.preview")}</button>
      {error && <div className="error-box" role="alert">{error}</div>}
      {preview && <>
        <p role="status">{t("copy.counts", { ready: preview.ready, skipped: preview.skipped, conflicts: preview.conflicts })}</p>
        {preview.conflicts > 0 && <div className="error-box">{t("copy.blocked")}</div>}
        {!preview.rows.length && <p className="empty">{t("copy.empty")}</p>}
        <div style={{ maxHeight: "32vh", overflowY: "auto" }}>
          {preview.rows.map((r, i) => <div className="list-item" key={i}>
            <strong>{r.name}</strong><div className="small">{fmtDate(r.date)} · {r.start_time}–{r.end_time}</div>
            <span className={`pill ${r.status === "conflict" ? "late" : r.status === "duplicate" ? "pending" : "working"}`}>{t(`copy.${r.status}`)}</span>
            {r.reason && <p className="small">{r.reason}</p>}
          </div>)}
        </div>
      </>}
      <div className="row" style={{ marginTop: 16 }}>
        {preview && <button type="button" className="btn" disabled={busy || preview.conflicts > 0 || preview.ready === 0} onClick={() => request(true)}>{t("copy.confirm", { n: preview.ready })}</button>}
        <button type="button" className="btn subtle" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
      </div>
    </form>
  </div>;
}
