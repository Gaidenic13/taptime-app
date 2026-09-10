import React, { useState } from "react";
import { api, fmtDate, fmtTime } from "../api.js";
import { useI18n } from "../i18n.jsx";

// A member's unresolved forgotten clock-outs: those hours count for nothing
// until a manager confirms the leaving time. "I left at" sends a correction
// request with a concrete time — no shrugging.
export default function MissingOut({ missing = [], onChange }) {
  const { t } = useI18n();
  const [times, setTimes] = useState({});
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  if (!missing.length) return null;

  const send = async (m) => {
    const time = times[m.id] || "";
    if (!/^\d{2}:\d{2}$/.test(time)) { setError(t("miss.needTime")); return; }
    setBusy(m.id); setError("");
    try {
      await api("/corrections", {
        method: "POST",
        body: { date: m.date, kind: "missing_out", requested_in: "", requested_out: time, reason: t("miss.reason") },
      });
      onChange?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ textAlign: "left" }}>
      {missing.map((m) => (
        <div className="error-box" key={m.id} style={{ marginTop: 10 }}>
          <strong>{t("miss.title", { date: fmtDate(m.date) })}</strong>
          <div className="small" style={{ marginTop: 4 }}>{t("miss.body", { time: fmtTime(m.clock_in) })}</div>
          {m.correction_pending ? (
            <div className="small" style={{ marginTop: 8, fontWeight: 600 }}>{t("miss.sent")}</div>
          ) : (
            <div className="row" style={{ marginTop: 10 }}>
              <span className="small" style={{ fontWeight: 600 }}>{t("miss.leftAt")}</span>
              <input type="time" value={times[m.id] || ""} onChange={(e) => setTimes({ ...times, [m.id]: e.target.value })}
                style={{ width: 120 }} />
              <button className="btn small" disabled={busy === m.id} onClick={() => send(m)}>{t("miss.send")}</button>
            </div>
          )}
        </div>
      ))}
      {error && <div className="small" style={{ color: "var(--red)", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
