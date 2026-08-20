import React, { useEffect, useState } from "react";
import { api, fmtDate, LEAVE_TYPES } from "../api.js";
import { useI18n } from "../i18n.jsx";

export default function Leave() {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [type, setType] = useState("annual");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = () => api("/leave").then(setData);
  useEffect(() => { load(); }, []);

  const requestedDays = (() => {
    if (!start || !end || end < start) return 0;
    let n = 0;
    for (let d = new Date(start + "T12:00"); d <= new Date(end + "T12:00"); d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 0 && d.getDay() !== 6) n++;
    }
    return n;
  })();

  const deductible = type === "annual" || type === "personal";

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setNotice("");
    try {
      await api("/leave", { method: "POST", body: { type, start_date: start, end_date: end, note } });
      setNotice(t("lv.submitted"));
      setStart(""); setEnd(""); setNote("");
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  if (!data) return null;

  return (
    <>
      <div className="page-head">
        <h1>{t("lv.title")}</h1>
        <p>{t("lv.balance")}: <strong>{data.balance} {t("common.days")}</strong></p>
      </div>

      <div className="grid2">
        <form className="card" onSubmit={submit}>
          <h2>{t("lv.request")}</h2>
          <label className="field" style={{ marginTop: 10 }}><span>{t("common.type")}</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {LEAVE_TYPES.map((k) => <option key={k} value={k}>{t(`leave.${k}`)}</option>)}
            </select>
          </label>
          <div className="grid2">
            <label className="field"><span>{t("common.from")}</span>
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
            </label>
            <label className="field"><span>{t("common.to")}</span>
              <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} required />
            </label>
          </div>
          {requestedDays > 0 && (
            <div className="card tinted" style={{ padding: 14, marginBottom: 12 }}>
              <strong>{requestedDays === 1 ? t("lv.workingDay") : t("lv.workingDays", { n: requestedDays })}</strong>
              {deductible && (
                <span className="muted"> · {t("lv.after", { n: Math.max(0, data.balance - requestedDays) })}</span>
              )}
            </div>
          )}
          <label className="field"><span>{t("lv.note")}</span>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("lv.notePh")} />
          </label>
          {error && <div className="error-box">{error}</div>}
          {notice && <div className="ok-box">{notice}</div>}
          <button className="btn">{t("att.submit")}</button>
        </form>

        <div className="card">
          <h2>{t("lv.mine")}</h2>
          {data.requests.length === 0 && <div className="empty">{t("lv.none")}</div>}
          {data.requests.map((r) => (
            <div className="list-item spread" key={r.id}>
              <div>
                <strong>{t(`leave.${r.type}`)}</strong>
                <div className="small muted">
                  {fmtDate(r.start_date)} → {fmtDate(r.end_date)} · {r.days} {r.days > 1 ? t("common.days") : t("common.day")}
                </div>
                {r.decision_note && <div className="small muted">{t("lv.manager")}: "{r.decision_note}"</div>}
              </div>
              <span className={`pill ${r.status}`}>{t(`status.${r.status}`)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
