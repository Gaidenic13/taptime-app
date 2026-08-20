import React, { useEffect, useState } from "react";
import { api, fmtDate, fmtMin, fmtTime, fmtDateTime } from "../api.js";
import { useAuth } from "../App.jsx";
import { useI18n } from "../i18n.jsx";

function DecideButtons({ onDecide, allowCompensate }) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  if (rejecting) {
    return (
      <div className="row" style={{ marginTop: 8 }}>
        <input placeholder={t("ap.rejectPh")} value={note} onChange={(e) => setNote(e.target.value)} style={{ maxWidth: 260 }} />
        <button className="btn danger small" onClick={() => onDecide("rejected", note)}>{t("ap.confirmReject")}</button>
        <button className="btn subtle small" onClick={() => setRejecting(false)}>{t("common.back")}</button>
      </div>
    );
  }
  return (
    <div className="row" style={{ marginTop: 8 }}>
      <button className="btn small" onClick={() => onDecide("approved", "")}>{t("common.approve")}</button>
      {allowCompensate && (
        <button className="btn subtle small" onClick={() => onDecide("compensated", "")}>{t("ap.compensate")}</button>
      )}
      <button className="btn ghost small" onClick={() => setRejecting(true)}>{t("common.reject")}</button>
    </div>
  );
}

export default function Approvals() {
  const { refreshPending } = useAuth();
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [notice, setNotice] = useState("");

  const load = () => api("/approvals").then(setData);
  useEffect(() => { load(); }, []);

  const after = (msg) => { setNotice(msg); load(); refreshPending(); };
  const decide = (type, id) => async (decision, note) => {
    await api(`/approvals/${type}/${id}`, { method: "POST", body: { decision, note } });
    after(t(`ap.decided.${decision}`));
  };
  const decideReview = (attId) => async (decision, note) => {
    await api(`/reviews/${attId}`, { method: "POST", body: { decision, note } });
    after(decision === "approved" ? t("ap.verified") : t("ap.reviewRejected"));
  };
  const dismissFlag = (id) => async () => {
    await api(`/flags/${id}/resolve`, { method: "POST", body: { note: "Reviewed" } });
    after(t("ap.flagResolved"));
  };

  if (!data) return null;
  const total = data.leaves.length + data.corrections.length + data.overtime.length +
    data.reviews.length + data.flags.length;

  const kindLabel = {
    missing_in: t("att.missingIn"), missing_out: t("att.missingOut"),
    wrong_hours: t("att.wrongHours"), other: t("att.other"),
  };

  return (
    <>
      <div className="page-head">
        <h1>{t("ap.title")}</h1>
        <p>{total === 0 ? t("ap.clear") : total === 1 ? t("ap.waitingOne") : t("ap.waiting", { n: total })}</p>
      </div>
      {notice && <div className="ok-box">{notice}</div>}

      {data.reviews.length > 0 && (
        <div className="card">
          <h2>{t("ap.reviews")}</h2>
          {data.reviews.map((r) => (
            <div className="list-item" key={r.id}>
              <div className="spread">
                <div>
                  <strong>{r.first_name} {r.last_name}</strong> <span className="muted">· {r.job_title} · {fmtDate(r.date)}</span>
                  <div className="small muted">
                    {t("common.in")} {fmtTime(r.clock_in)}
                    {r.clock_out ? ` · ${t("common.out")} ${fmtTime(r.clock_out)}` : ` · ${t("ap.stillOpen")}`}
                    {` · ${r.location_name || t("ap.noLocation")} · ${t("ap.method")} ${r.clock_in_method}`}
                  </div>
                  <div className="small" style={{ color: "var(--red)", fontWeight: 600 }}>
                    {t("ap.signals")}: {JSON.parse(r.risk_signals || "[]").join(", ") || "—"}
                  </div>
                </div>
                <DecideButtons onDecide={decideReview(r.id)} />
              </div>
            </div>
          ))}
        </div>
      )}

      {data.flags.length > 0 && (
        <div className="card">
          <h2>{t("ap.flags")}</h2>
          {data.flags.map((f) => (
            <div className="list-item spread" key={f.id}>
              <div>
                <strong>{f.first_name} {f.last_name}</strong>
                <span className={`pill risk-${f.risk_level}`} style={{ marginLeft: 8 }}>{f.risk_level}</span>
                <div className="small muted">{f.kind} · {f.detail || "—"} · {fmtDateTime(f.created_at)}</div>
              </div>
              <button className="btn subtle small" onClick={dismissFlag(f.id)}>{t("ap.markReviewed")}</button>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>{t("ap.leaves")}</h2>
        {data.leaves.length === 0 && <div className="empty">—</div>}
        {data.leaves.map((l) => (
          <div className="list-item" key={l.id}>
            <div className="spread">
              <div>
                <strong>{l.first_name} {l.last_name}</strong> <span className="muted">· {l.job_title}</span>
                <div className="small muted">
                  {t(`leave.${l.type}`)} · {fmtDate(l.start_date)} → {fmtDate(l.end_date)} · {l.days}{" "}
                  {l.days > 1 ? t("common.days") : t("common.day")} · {t("ap.balance")} {l.balance}
                </div>
                {l.note && <div className="small">"{l.note}"</div>}
                {l.staffing_impact?.length > 0 && (
                  <div className="small" style={{ color: "var(--red)", fontWeight: 600 }}>
                    {l.staffing_impact.slice(0, 3).map((im, i) => (
                      <div key={i}>
                        {t("ap.impact", {
                          date: fmtDate(im.date), a: im.remaining, b: im.required,
                          role: im.role, location: im.location, band: im.band,
                        })}
                      </div>
                    ))}
                    {l.staffing_impact.length > 3 && <div>{t("ap.impactMore", { n: l.staffing_impact.length - 3 })}</div>}
                  </div>
                )}
              </div>
              <DecideButtons onDecide={decide("leave", l.id)} />
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>{t("ap.corrections")}</h2>
        {data.corrections.length === 0 && <div className="empty">—</div>}
        {data.corrections.map((c) => (
          <div className="list-item" key={c.id}>
            <div className="spread">
              <div>
                <strong>{c.first_name} {c.last_name}</strong> <span className="muted">· {fmtDate(c.date)}</span>
                <div className="small muted">
                  {kindLabel[c.kind]}
                  {c.requested_in && ` · ${t("common.in")} ${c.requested_in}`}
                  {c.requested_out && ` · ${t("common.out")} ${c.requested_out}`}
                </div>
                {c.reason && <div className="small">"{c.reason}"</div>}
              </div>
              <DecideButtons onDecide={decide("correction", c.id)} />
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>{t("ap.overtime")}</h2>
        {data.overtime.length === 0 && <div className="empty">—</div>}
        {data.overtime.map((o) => (
          <div className="list-item" key={o.id}>
            <div className="spread">
              <div>
                <strong>{o.first_name} {o.last_name}</strong> <span className="muted">· {fmtDate(o.date)}</span>
                <div className="small muted">{t("ap.otDetected", { dur: fmtMin(o.minutes) })}</div>
              </div>
              <DecideButtons onDecide={decide("overtime", o.id)} allowCompensate />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
