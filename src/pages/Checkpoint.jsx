import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, getGeo, fmtTime } from "../api.js";
import { useAuth } from "../App.jsx";
import { useI18n, LangSwitch } from "../i18n.jsx";

// Landing page for a QR poster / NFC tag. The URL only identifies the
// checkpoint; a short-lived server challenge plus the employee's authenticated
// session are what actually clock them in.
export default function Checkpoint() {
  const { code } = useParams();
  const { user, login } = useAuth();
  const { t } = useI18n();
  const [challenge, setChallenge] = useState(null);
  const [checkpoint, setCheckpoint] = useState(null);
  const [today, setToday] = useState(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
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

  const doLogin = async (e) => {
    e.preventDefault();
    setError("");
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
    }
  };

  const act = async (action) => {
    setBusy(true); setError("");
    try {
      const geo = await getGeo();
      const d = await api("/checkpoint/consume", {
        method: "POST",
        body: { challenge, action, geo },
      });
      setToday(d.today);
      const att = d.today.attendance;
      setDone(action === "clock-out"
        ? t("term.clockedOut", { time: fmtTime(att?.clock_out) })
        : t("term.clockedIn", { time: fmtTime(att?.clock_in) }));
    } catch (e) {
      setError(e.message);
      if (e.status === 410) fetchChallenge(); // expired — get a fresh challenge
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

        {!user && checkpoint && (
          <form onSubmit={doLogin} style={{ textAlign: "left", marginTop: 10 }}>
            <p className="muted small" style={{ textAlign: "center" }}>{t("cp.signin")}</p>
            <label className="field"><span>{t("common.email")}</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </label>
            <label className="field"><span>{t("common.password")}</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <button className="btn big">{t("login.signin")}</button>
          </form>
        )}

        {user && !done && today && (
          <>
            <span className={`pill ${s}`}>{t(`status.${s}`)}</span>
            <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
              {(s === "upcoming" || s === "late" || s === "no_shift") && (
                <button className="btn big" disabled={busy} onClick={() => act("clock-in")}>
                  {busy ? t("cp.recording") : t("cp.clockIn", { name: user.first_name })}
                </button>
              )}
              {(s === "working" || s === "break") && (
                <button className="btn big" disabled={busy} onClick={() => act("clock-out")}>
                  {busy ? t("cp.recording") : t("dash.clockOut")}
                </button>
              )}
              {(s === "complete" || s === "requires_review") && (
                <p className="muted">{t("cp.already")}</p>
              )}
            </div>
          </>
        )}

        {done && (
          <>
            <div className="ok-box">{done}</div>
            {today?.status === "requires_review" && (
              <p className="small muted">{t("cp.reviewNote")}</p>
            )}
          </>
        )}

        <p className="small muted" style={{ marginTop: 16 }}>
          <Link to="/">{t("cp.openApp")}</Link>
        </p>
      </div>
    </div>
  );
}
