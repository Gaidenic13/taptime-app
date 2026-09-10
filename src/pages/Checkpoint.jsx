import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, getGeo, fmtTime, fmtMin } from "../api.js";
import { useAuth } from "../App.jsx";
import { useI18n, LangSwitch } from "../i18n.jsx";

// Landing page for a QR poster / NFC tag. The URL only identifies the
// checkpoint; a short-lived server challenge plus a light identity step are
// what actually clock someone in.
//
// Friendliest path: enter your 4-digit PIN and the server decides in vs out.
// Employees already signed into the app on this phone skip even that — they
// get a one-tap button. Email sign-in stays available as a fallback.
export default function Checkpoint() {
  const { code } = useParams();
  const { user, login } = useAuth();
  const { t } = useI18n();
  const [challenge, setChallenge] = useState(null);
  const [checkpoint, setCheckpoint] = useState(null);
  const [today, setToday] = useState(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { name, did, time, worked }
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("pin"); // pin | email
  const [pin, setPin] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const fetchChallenge = () => {
    setError("");
    return api(`/checkpoint/${code}`)
      .then((d) => { setChallenge(d.challenge); setCheckpoint(d.checkpoint); })
      .catch((e) => setError(e.message));
  };

  useEffect(() => { fetchChallenge(); }, [code]);
  useEffect(() => {
    if (user) api("/me").then((d) => setToday(d.today)).catch(() => {});
  }, [user]);

  // --- PIN flow (no session) ---
  const submitPin = async (fullPin) => {
    setBusy(true); setError("");
    try {
      const geo = await getGeo();
      const d = await api("/checkpoint/pin", {
        method: "POST",
        body: { challenge, pin: fullPin, geo },
      });
      const att = d.today.attendance;
      setResult({
        name: d.user.first_name,
        did: d.did,
        time: d.did === "out" ? fmtTime(att?.clock_out) : fmtTime(att?.clock_in),
        worked: d.today.worked_min,
        review: d.today.status === "requires_review",
      });
    } catch (e) {
      setError(e.message);
      if (e.status === 410) fetchChallenge();
    } finally {
      setPin("");
      setBusy(false);
    }
  };

  const press = (digit) => {
    if (busy) return;
    const next = pin + digit;
    setPin(next);
    if (next.length === 4) submitPin(next);
  };

  const resetForNext = () => {
    setResult(null);
    fetchChallenge(); // the previous challenge was consumed
  };

  // --- email/session flow ---
  const doLogin = async (e) => {
    e.preventDefault();
    setError("");
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
    }
  };

  const actSession = async (action) => {
    setBusy(true); setError("");
    try {
      const geo = await getGeo();
      const d = await api("/checkpoint/consume", {
        method: "POST",
        body: { challenge, action, geo },
      });
      setToday(d.today);
      const att = d.today.attendance;
      setResult({
        name: user.first_name,
        did: action === "clock-out" ? "out" : "in",
        time: action === "clock-out" ? fmtTime(att?.clock_out) : fmtTime(att?.clock_in),
        worked: d.today.worked_min,
        review: d.today.status === "requires_review",
      });
    } catch (e) {
      setError(e.message);
      if (e.status === 410) fetchChallenge();
    } finally {
      setBusy(false);
    }
  };

  const s = today?.status;

  return (
    <div className="checkpoint-wrap">
      <div className="corner-lang"><LangSwitch /></div>
      <div className="card checkpoint-card">
        <div className="brand"><span className="brand-mark">T</span>TapTime</div>
        {checkpoint ? (
          <>
            <h2>{checkpoint.name}</h2>
            <p className="muted">{checkpoint.location}</p>
          </>
        ) : (
          <p className="muted">{t("cp.lookup")}</p>
        )}
        {error && <div className="error-box">{error}</div>}

        {/* -------- result of a tap (any flow) -------- */}
        {result && (
          <>
            <h2 style={{ marginTop: 6 }}>{t("cp.hi", { name: result.name })}</h2>
            {result.did === "in" && <div className="ok-box">{t("term.clockedIn", { time: result.time })}</div>}
            {result.did === "out" && (
              <div className="ok-box">
                {t("term.clockedOut", { time: result.time })}
                {result.worked > 0 && <div>{t("cp.workedToday", { dur: fmtMin(result.worked) })}</div>}
              </div>
            )}
            {result.did === "in_recent" && <div className="ok-box">{t("cp.justIn", { time: result.time })}</div>}
            {result.did === "done" && <p className="muted">{t("term.recorded")}</p>}
            {result.review && <p className="small muted">{t("cp.reviewNote")}</p>}
            <button className="btn ghost" style={{ marginTop: 10 }} onClick={resetForNext}>{t("common.done")}</button>
          </>
        )}

        {/* -------- signed-in session: one-tap button -------- */}
        {!result && user && today && (
          <>
            <span className={`pill ${s}`}>{t(`status.${s}`)}</span>
            <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
              {(s === "upcoming" || s === "late" || s === "no_shift") && (
                <button className="btn big" disabled={busy} onClick={() => actSession("clock-in")}>
                  {busy ? t("cp.recording") : t("cp.clockIn", { name: user.first_name })}
                </button>
              )}
              {(s === "working" || s === "break") && (
                <button className="btn big" disabled={busy} onClick={() => actSession("clock-out")}>
                  {busy ? t("cp.recording") : t("dash.clockOut")}
                </button>
              )}
              {(s === "complete" || s === "requires_review") && (
                <p className="muted">{t("cp.already")}</p>
              )}
            </div>
          </>
        )}

        {/* -------- no session: PIN pad (default) or email fallback -------- */}
        {!result && !user && checkpoint && mode === "pin" && (
          <>
            <p className="muted" style={{ marginBottom: 2 }}>{t("cp.enterPin")}</p>
            <p className="small muted">{t("cp.pinSub")}</p>
            <div className="pin-dots">
              {[0, 1, 2, 3].map((i) => <span key={i} className={i < pin.length ? "on" : ""} />)}
            </div>
            <div className="pin-pad">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <button key={n} disabled={busy} onClick={() => press(String(n))}>{n}</button>
              ))}
              <button disabled={busy} onClick={() => setPin("")}>C</button>
              <button disabled={busy} onClick={() => press("0")}>0</button>
              <button disabled={busy} onClick={() => setPin(pin.slice(0, -1))}>⌫</button>
            </div>
            <p className="small muted" style={{ marginTop: 14 }}>
              <a href="#email" onClick={(e) => { e.preventDefault(); setMode("email"); }}>{t("cp.useEmail")}</a>
            </p>
          </>
        )}

        {!result && !user && checkpoint && mode === "email" && (
          <form onSubmit={doLogin} style={{ textAlign: "left", marginTop: 10 }}>
            <p className="muted small" style={{ textAlign: "center" }}>{t("cp.signin")}</p>
            <label className="field"><span>{t("common.email")}</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </label>
            <label className="field"><span>{t("common.password")}</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <button className="btn big">{t("login.signin")}</button>
            <p className="small muted" style={{ marginTop: 12, textAlign: "center" }}>
              <a href="#pin" onClick={(e) => { e.preventDefault(); setMode("pin"); }}>{t("cp.usePin")}</a>
            </p>
          </form>
        )}

        <p className="small muted" style={{ marginTop: 16 }}>
          <Link to="/">{t("cp.openApp")}</Link>
        </p>
      </div>
    </div>
  );
}
