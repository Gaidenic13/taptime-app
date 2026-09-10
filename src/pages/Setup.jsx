import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import QRCode from "qrcode";
import { api, fmtTime } from "../api.js";
import { useI18n } from "../i18n.jsx";

// Out-of-the-box onboarding wizard: the clinic manager unboxes the product,
// walks these three steps once, and from then on the everyday surface for
// workers is just the scan page. Finishing marks the org as onboarded.
function QrImg({ url }) {
  const [src, setSrc] = useState("");
  useEffect(() => { QRCode.toDataURL(url, { width: 480, margin: 1 }).then(setSrc); }, [url]);
  return src ? <img className="qr-box" src={src} alt={`QR ${url}`} width={150} height={150} /> : null;
}

export default function Setup() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [members, setMembers] = useState([]);
  const [checkpoint, setCheckpoint] = useState(null);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
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
    if (step === 2) {
      const poll = () =>
        api("/team/today").then((d) => {
          const rows = [];
          for (const r of d.roster) {
            for (const s of r.sessions) {
              rows.push({ name: r.name, in: s.in, out: s.out });
            }
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
      setJustAdded({ name: `${first} ${last}`.trim(), pin: d.pin });
      setFirst(""); setLast("");
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const url = checkpoint ? `${window.location.origin}/checkpoint/${checkpoint.code}` : "";
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard unavailable */ }
  };

  const finish = async () => {
    try {
      await api("/admin/settings", { method: "PUT", body: { onboarded: true } });
      navigate("/team");
    } catch (e) {
      setError(e.message);
    }
  };

  const STEPS = ["setup.s1", "setup.s2", "setup.s3"];

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
            <div className="ok-box">{justAdded.name} — PIN <strong>{justAdded.pin}</strong></div>
          )}
          {members.length > 0 && (
            <>
              <h3 style={{ marginTop: 16 }}>{t("setup.team")}</h3>
              {members.map((m) => (
                <div className="list-item spread" key={m.id}>
                  <strong>{m.first_name} {m.last_name}</strong>
                  <span className="pill no_shift">PIN {m.pin || "—"}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {step === 1 && checkpoint && (
        <div className="card">
          <h2>{t("setup.s2")}</h2>
          <p className="small muted">{t("setup.s2Sub")}</p>
          <div className="row" style={{ marginTop: 12, alignItems: "flex-start" }}>
            <QrImg url={url} />
            <div style={{ flex: 1, minWidth: 220 }}>
              <div className="card tinted" style={{ padding: 12, wordBreak: "break-all", fontSize: 13, fontWeight: 600 }}>
                {url}
              </div>
              <button className="btn small" onClick={copy}>{copied ? t("setup.copied") : t("setup.copy")}</button>
              <ol className="small muted" style={{ paddingLeft: 18, marginTop: 12, lineHeight: 1.7 }}>
                <li>{t("setup.nfc1")}</li>
                <li>{t("setup.nfc2")}</li>
                <li>{t("setup.nfc3")}</li>
                <li>{t("setup.nfc4")}</li>
              </ol>
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h2>{t("setup.s3")}</h2>
          <p className="small muted">{t("setup.s3Sub")}</p>
          {checkpoint && (
            <a className="btn subtle" style={{ display: "inline-block", margin: "8px 0 14px" }}
              href={`/checkpoint/${checkpoint.code}`} target="_blank" rel="noreferrer">
              {t("setup.open")}
            </a>
          )}
          <h3>{t("setup.live")}</h3>
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
        {step < 2 && (
          <button className="btn" onClick={() => setStep(step + 1)}>{t("setup.next")}</button>
        )}
        {step === 2 && (
          <button className="btn" onClick={finish}>{t("setup.finish")}</button>
        )}
      </div>
    </>
  );
}
