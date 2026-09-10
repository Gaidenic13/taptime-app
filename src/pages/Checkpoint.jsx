import React, { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api, setToken, getGeo, fmtTime, fmtMin } from "../api.js";
import { useAuth } from "../App.jsx";
import { useI18n, LangSwitch } from "../i18n.jsx";

// The scan page — the only thing employees ever touch.
//  · Unclaimed factory tag  → "Set up your clinic" (admin claim form)
//  · First scan on a phone  → enter your activation code once; the phone is
//    linked to you from then on
//  · Every later scan       → automatic: the server records check-in or
//    check-out (hour, date, device) with no typing at all
function ClaimForm({ code }) {
  const { t } = useI18n();
  const { user, adoptSession } = useAuth();
  const navigate = useNavigate();
  const adminSession = user && (user.role === "admin" || user.role === "owner");
  const [mode, setMode] = useState("new"); // new | existing
  const [form, setForm] = useState({ clinic_name: "", first_name: "", last_name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attached, setAttached] = useState(null); // { name, clinic }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submitNew = async (e) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      const d = await api("/orgs/claim", { method: "POST", body: { ...form, tag_code: code } });
      setToken(d.token);
      adoptSession(d.user);
      navigate("/setup");
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const submitAttach = async (e) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      const d = adminSession
        ? await api("/orgs/attach-session", { method: "POST", body: { tag_code: code } })
        : await api("/orgs/attach", {
            method: "POST",
            body: { tag_code: code, email: form.email, password: form.password },
          });
      setAttached({ name: d.checkpoint.name, clinic: d.clinic });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (attached) {
    return (
      <div style={{ marginTop: 10 }}>
        <div className="ok-box">{t("cp.attached", { name: attached.name, clinic: attached.clinic })}</div>
      </div>
    );
  }

  // Admin already signed in on this phone: nothing to type — one confirm tap.
  if (adminSession) {
    return (
      <form onSubmit={submitAttach} style={{ marginTop: 8 }}>
        <h2>{t("cp.claimExisting")}</h2>
        <p className="muted small">{t("cp.attachSub")}</p>
        {error && <div className="error-box">{error}</div>}
        <button className="btn big" disabled={busy}>{busy ? t("cp.recording") : t("cp.attachBtn")}</button>
      </form>
    );
  }

  return (
    <form onSubmit={mode === "new" ? submitNew : submitAttach} style={{ textAlign: "left", marginTop: 8 }}>
      <h2 style={{ textAlign: "center" }}>{t("cp.claimTitle")}</h2>
      <p className="muted small" style={{ textAlign: "center" }}>{t("cp.claimSub")}</p>
      <div className="seg" style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
        <button type="button" className={mode === "new" ? "active" : ""} style={{ flex: 1 }}
          onClick={() => setMode("new")}>{t("cp.claimNew")}</button>
        <button type="button" className={mode === "existing" ? "active" : ""} style={{ flex: 1 }}
          onClick={() => setMode("existing")}>{t("cp.claimExisting")}</button>
      </div>
      {mode === "new" && (
        <>
          <label className="field"><span>{t("signup.clinic")}</span>
            <input value={form.clinic_name} onChange={set("clinic_name")} required />
          </label>
          <div className="grid2">
            <label className="field"><span>{t("signup.first")}</span>
              <input value={form.first_name} onChange={set("first_name")} required />
            </label>
            <label className="field"><span>{t("signup.last")}</span>
              <input value={form.last_name} onChange={set("last_name")} required />
            </label>
          </div>
        </>
      )}
      <label className="field"><span>{t("common.email")}</span>
        <input type="email" value={form.email} onChange={set("email")} required />
      </label>
      <label className="field"><span>{t("common.password")}</span>
        <input type="password" value={form.password} onChange={set("password")} minLength={6} required />
      </label>
      {error && <div className="error-box">{error}</div>}
      <button className="btn big" disabled={busy}>
        {busy ? t("signup.creating") : mode === "new" ? t("cp.claimBtn") : t("cp.attachBtn")}
      </button>
    </form>
  );
}

export default function Checkpoint() {
  const { code } = useParams();
  const { user } = useAuth();
  const { t } = useI18n();
  const [challenge, setChallenge] = useState(null);
  const [checkpoint, setCheckpoint] = useState(null);
  const [today, setToday] = useState(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { name, did, time, worked, review, activated }
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState("");
  const [unclaimed, setUnclaimed] = useState(false);
  const autoFired = useRef(false);

  const isEmployee = user && user.role === "employee";
  const isStaffAdmin = user && user.role !== "employee";

  const fetchChallenge = () => {
    setError("");
    return api(`/checkpoint/${code}`)
      .then((d) => {
        if (d.unclaimed) { setUnclaimed(true); return; }
        setChallenge(d.challenge); setCheckpoint(d.checkpoint);
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => { fetchChallenge(); }, [code]);
  useEffect(() => {
    if (isStaffAdmin) api("/me").then((d) => setToday(d.today)).catch(() => {});
  }, [isStaffAdmin]);

  const showResult = (d, extra = {}) => {
    const att = d.today.attendance;
    setResult({
      name: d.user?.first_name || user?.first_name,
      did: d.did,
      time: d.did === "out" ? fmtTime(att?.clock_out) : fmtTime(att?.clock_in),
      worked: d.today.worked_min,
      review: d.today.status === "requires_review",
      ...extra,
    });
  };

  // Activated phone (employee session): the scan itself does everything.
  useEffect(() => {
    if (!isEmployee || !challenge || autoFired.current) return;
    autoFired.current = true;
    (async () => {
      setBusy(true);
      try {
        const geo = await getGeo();
        const d = await api("/checkpoint/tap", { method: "POST", body: { challenge, geo } });
        showResult(d);
      } catch (e) {
        setError(e.message);
        if (e.status === 410) fetchChallenge();
      } finally {
        setBusy(false);
      }
    })();
  }, [isEmployee, challenge]);

  // First scan on this phone: activation code → persistent member session.
  const submitPin = async (fullPin) => {
    setBusy(true); setError("");
    try {
      const geo = await getGeo();
      const d = await api("/checkpoint/pin", {
        method: "POST",
        body: { challenge, pin: fullPin, geo },
      });
      if (d.token) setToken(d.token); // link this phone
      showResult(d, { activated: true });
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

  // Admin/manager scanning: explicit buttons (they may just be testing).
  const actSession = async (action) => {
    setBusy(true); setError("");
    try {
      const geo = await getGeo();
      const d = await api("/checkpoint/consume", { method: "POST", body: { challenge, action, geo } });
      setToday(d.today);
      showResult({ user: { first_name: user.first_name }, did: action === "clock-out" ? "out" : "in", today: d.today });
    } catch (e) {
      setError(e.message);
      if (e.status === 410) fetchChallenge();
    } finally {
      setBusy(false);
    }
  };

  const notMe = () => {
    setToken(null);
    window.location.reload();
  };

  const s = today?.status;

  return (
    <div className="checkpoint-wrap">
      <div className="corner-lang"><LangSwitch /></div>
      <div className="card checkpoint-card">
        <div className="brand"><span className="brand-mark">T</span>TapTime</div>
        {unclaimed ? (
          <ClaimForm code={code} />
        ) : checkpoint ? (
          <>
            <h2>{checkpoint.name}</h2>
            <p className="muted">{checkpoint.location}</p>
          </>
        ) : (
          <p className="muted">{t("cp.lookup")}</p>
        )}
        {!unclaimed && error && <div className="error-box">{error}</div>}

        {/* -------- scan result -------- */}
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
            {result.activated && <p className="small muted">{t("cp.activated")}</p>}
            {result.review && <p className="small muted">{t("cp.reviewNote")}</p>}
          </>
        )}

        {/* -------- activated employee phone: busy indicator only -------- */}
        {!result && isEmployee && checkpoint && (
          <p className="muted" style={{ marginTop: 10 }}>{t("cp.recording")}</p>
        )}

        {/* -------- admin/manager session: explicit buttons -------- */}
        {!result && isStaffAdmin && today && checkpoint && (
          <>
            <span className={`pill ${s}`}>{t(`status.${s}`)}</span>
            <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
              {(s === "working" || s === "break") ? (
                <button className="btn big" disabled={busy} onClick={() => actSession("clock-out")}>
                  {busy ? t("cp.recording") : t("dash.clockOut")}
                </button>
              ) : (
                <button className="btn big" disabled={busy} onClick={() => actSession("clock-in")}>
                  {busy ? t("cp.recording") : t("cp.clockIn", { name: user.first_name })}
                </button>
              )}
            </div>
          </>
        )}

        {/* -------- no session yet: one-time activation -------- */}
        {!result && !user && checkpoint && (
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
          </>
        )}

        {user && (
          <p className="small muted" style={{ marginTop: 16 }}>
            <a href="#notme" onClick={(e) => { e.preventDefault(); notMe(); }}>
              {t("cp.notYou", { name: user.first_name })}
            </a>
          </p>
        )}
        {isStaffAdmin && (
          <p className="small muted" style={{ marginTop: 4 }}>
            <Link to="/">{t("cp.openApp")}</Link>
          </p>
        )}
      </div>
    </div>
  );
}
