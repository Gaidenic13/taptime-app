import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { fmtTime } from "../api.js";
import { I18nProvider, useI18n, LangSwitch } from "../i18n.jsx";

// Kiosk mode: a shared clinic device with a restricted session. The device must
// be registered by an admin (one-time setup code) before any PIN works.
const KIOSK_KEY = "taptime_kiosk_token";
const KIOSK_NAME = "taptime_kiosk_name";

async function kioskFetch(path, body) {
  const res = await fetch(`/api/kiosk${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Kiosk-Token": localStorage.getItem(KIOSK_KEY) || "",
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || "Request failed");
    e.code = data.error;
    throw e;
  }
  return data;
}

function Setup({ onDone }) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const res = await fetch("/api/kiosk/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setup_code: code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      localStorage.setItem(KIOSK_KEY, data.token);
      localStorage.setItem(KIOSK_NAME, data.kiosk.name);
      onDone();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <form onSubmit={submit}>
      <h2>{t("term.register")}</h2>
      <p className="muted small">{t("term.registerSub")}</p>
      <label className="field" style={{ textAlign: "left" }}>
        <span>{t("term.setupCode")}</span>
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="DEMO1234" required style={{ textAlign: "center", letterSpacing: "0.2em", fontWeight: 600 }} />
      </label>
      {error && <div className="error-box">{error}</div>}
      <button className="btn big">{t("term.registerBtn")}</button>
      <p className="small muted" style={{ marginTop: 14 }}><Link to="/">{t("term.backLogin")}</Link></p>
    </form>
  );
}

function TerminalInner() {
  const { t } = useI18n();
  const [registered, setRegistered] = useState(!!localStorage.getItem(KIOSK_KEY));
  const [pin, setPin] = useState("");
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const resetTimer = useRef(null);

  const reset = () => { setPin(""); setState(null); setError(""); setConfirmation(""); };
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  const scheduleReset = (ms) => {
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(reset, ms);
  };

  const handleKioskError = (e) => {
    if (e.code === "kiosk_not_registered") {
      localStorage.removeItem(KIOSK_KEY);
      setRegistered(false);
      return;
    }
    setError(e.message);
  };

  const press = async (digit) => {
    setError("");
    const next = pin + digit;
    setPin(next);
    if (next.length < 4) return;
    try {
      const data = await kioskFetch("/pin", { pin: next });
      setState(data);
      scheduleReset(30000);
    } catch (e) {
      handleKioskError(e);
      setPin("");
    }
  };

  const act = async (action) => {
    try {
      const data = await kioskFetch(`/${action}`, { pin });
      const labels = {
        "clock-in": t("term.clockedIn", { time: fmtTime(data.today.attendance?.clock_in) }),
        "clock-out": t("term.clockedOut", { time: fmtTime(data.today.attendance?.clock_out) }),
        "break-start": t("term.breakStarted"),
        "break-end": t("term.breakEnded"),
      };
      setConfirmation(labels[action]);
      setState(data);
      scheduleReset(5000);
    } catch (e) {
      handleKioskError(e);
    }
  };

  return (
    <div className="terminal-wrap">
      <div className="corner-lang"><LangSwitch /></div>
      <div className="card terminal-card">
        <div className="brand"><span className="brand-mark">T</span>{t("term.title")}</div>
        {!registered ? (
          <Setup onDone={() => setRegistered(true)} />
        ) : !state ? (
          <>
            <p className="muted">{localStorage.getItem(KIOSK_NAME) || "Kiosk"} · {t("term.enterPin")}</p>
            <div className="pin-dots">
              {[0, 1, 2, 3].map((i) => <span key={i} className={i < pin.length ? "on" : ""} />)}
            </div>
            {error && <div className="error-box">{error}</div>}
            <div className="pin-pad">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <button key={n} onClick={() => press(String(n))}>{n}</button>
              ))}
              <button onClick={() => setPin("")}>C</button>
              <button onClick={() => press("0")}>0</button>
              <button onClick={() => setPin(pin.slice(0, -1))}>⌫</button>
            </div>
            <p className="small muted" style={{ marginTop: 16 }}>
              <Link to="/">{t("term.backLogin")}</Link>
            </p>
          </>
        ) : (
          <>
            <h2>{t("term.welcome", { name: state.user.first_name })}</h2>
            <p className="muted">{state.user.job_title}</p>
            <span className={`pill ${state.today.status}`}>{t(`status.${state.today.status}`)}</span>
            {state.today.shift && (
              <p className="muted small" style={{ marginTop: 8 }}>
                {t("term.yourShift", { start: state.today.shift.start_time, end: state.today.shift.end_time })}
              </p>
            )}
            {confirmation && <div className="ok-box">{confirmation}</div>}
            {error && <div className="error-box">{error}</div>}
            <div style={{ display: "grid", gap: 10, marginTop: 18 }}>
              {state.today.status === "working" ? (
                <>
                  <button className="btn big subtle" onClick={() => act("break-start")}>{t("dash.startBreak")}</button>
                  <button className="btn big" onClick={() => act("clock-out")}>{t("dash.clockOut")}</button>
                </>
              ) : state.today.status === "break" ? (
                <button className="btn big" onClick={() => act("break-end")}>{t("dash.endBreak")}</button>
              ) : ["complete", "requires_review"].includes(state.today.status) ? (
                <p className="muted">{t("term.recorded")}</p>
              ) : (
                <button className="btn big" onClick={() => act("clock-in")}>{t("term.startWork")}</button>
              )}
              <button className="btn ghost" onClick={reset}>{t("common.done")}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Terminal renders outside the app shell, so it brings its own I18nProvider.
export default function Terminal() {
  return (
    <I18nProvider>
      <TerminalInner />
    </I18nProvider>
  );
}
