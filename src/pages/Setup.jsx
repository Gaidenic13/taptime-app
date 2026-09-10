import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, fmtTime } from "../api.js";
import { useI18n } from "../i18n.jsx";

// Out-of-the-box onboarding: the tag arrives already written and linked, so
// the manager only (1) adds the team and (2) watches the test scan land.
// Finishing marks the org as onboarded; workers only ever see the scan page.
export default function Setup() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [members, setMembers] = useState([]);
  const [checkpoint, setCheckpoint] = useState(null);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [error, setError] = useState("");
  const [justAdded, setJustAdded] = useState(null);
  const [scans, setScans] = useState([]);
  const pollRef = useRef(null);

  const load = () => {
    api("/employees").then((d) => setMembers(d.employees.filter((e) => e.active)));
    api("/admin/checkpoints").then((d) => setCheckpoint(d.checkpoints[0] || null));
  };
  useEffect(() => { load(); }, []);

  // Live scan feed on the test step — the "it works!" unboxing moment.
  useEffect(() => {
    clearInterval(pollRef.current);
    if (step === 1) {
      const poll = () =>
        api("/team/today").then((d) => {
          const rows = [];
          for (const r of d.roster) {
            for (const s of r.sessions) rows.push({ name: r.name, in: s.in, out: s.out });
          }
          rows.sort((a, b) => (a.in < b.in ? 1 : -1));
          setScans(rows.slice(0, 6));
        }).catch(() => {});
      poll();
      pollRef.current = setInterval(poll, 5000);
    }
    return () => clearInterval(pollRef.current);
  }, [step]);

  const add = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const d = await api("/employees/quick", { method: "POST", body: { first_name: first, last_name: last } });
      setJustAdded({ name: `${first} ${last}`.trim() });
      setFirst(""); setLast("");
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const finish = async () => {
    try {
      await api("/admin/settings", { method: "PUT", body: { onboarded: true } });
      navigate("/team");
    } catch (e) {
      setError(e.message);
    }
  };

  const STEPS = ["setup.s1", "setup.s3"];

  return (
    <>
      <div className="page-head">
        <h1>{t("setup.title")}</h1>
        <p>{t("setup.sub")}</p>
      </div>

      <div className="tabs">
        {STEPS.map((key, i) => (
          <button key={key} className={step === i ? "active" : ""} onClick={() => setStep(i)}>{t(key)}</button>
        ))}
      </div>

      {step === 0 && (
        <div className="card">
          <h2>{t("setup.s1")}</h2>
          <p className="small muted">{t("setup.s1Sub")}</p>
          <form className="row" onSubmit={add} style={{ marginTop: 10 }}>
            <input value={first} onChange={(e) => setFirst(e.target.value)} placeholder={t("emp.first")} required style={{ flex: 1, minWidth: 120 }} />
            <input value={last} onChange={(e) => setLast(e.target.value)} placeholder={t("emp.last")} style={{ flex: 1, minWidth: 120 }} />
            <button className="btn">{t("setup.addBtn")}</button>
          </form>
          {error && <div className="error-box">{error}</div>}
          {justAdded && (
            <div className="ok-box">{t("setup.added", { name: justAdded.name })}</div>
          )}
          {members.length > 0 && (
            <>
              <h3 style={{ marginTop: 16 }}>{t("setup.team")}</h3>
              {members.map((m) => (
                <div className="list-item spread" key={m.id}>
                  <strong>{m.first_name} {m.last_name}</strong>
                  <span className={`pill ${m.phone_linked ? "working" : "no_shift"}`}>{t(m.phone_linked ? "emp.phoneLinked" : "emp.noPhone")}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="card">
          <h2>{t("setup.s3")}</h2>
          <p className="small muted">{t("setup.s3Sub")}</p>
          <h3 style={{ marginTop: 14 }}>{t("setup.live")}</h3>
          {scans.length === 0 && <div className="empty">{t("setup.waiting")}</div>}
          {scans.map((s, i) => (
            <div className="list-item spread" key={i}>
              <strong>{s.name}</strong>
              <span className={`pill ${s.out ? "no_shift" : "working"}`}>
                {fmtTime(s.in)} → {s.out ? fmtTime(s.out) : "…"}
              </span>
            </div>
          ))}
        </div>
      )}

      {error && step !== 0 && <div className="error-box">{error}</div>}
      <div className="row" style={{ marginTop: 4 }}>
        {step > 0 && (
          <button className="btn subtle" onClick={() => setStep(step - 1)}>{t("common.back")}</button>
        )}
        {step === 0 && (
          <button className="btn" onClick={() => setStep(1)}>{t("setup.next")}</button>
        )}
        {step === 1 && (
          <button className="btn" onClick={finish}>{t("setup.finish")}</button>
        )}
      </div>
    </>
  );
}
