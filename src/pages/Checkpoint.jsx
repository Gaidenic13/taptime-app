import React, { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api, setToken, getGeo, fmtTime, fmtMin } from "../api.js";
import { useAuth } from "../App.jsx";
import { useI18n, LangSwitch } from "../i18n.jsx";
import Clock from "../components/Clock.jsx";
import DayProgress from "../components/DayProgress.jsx";

// The scan page — the only thing employees ever touch.
//  · Unclaimed factory tag  → "Set up your clinic" (admin claim form)
//  · Unlinked phone         → "I'm new" (pending account) or "this is my
//    phone" (link request); an admin approves; no codes anywhere
//  · Trusted phone          → one explicit button (Clock in / Clock out),
//    valid only on a real scan — refreshing the page records nothing
//  · Any other phone        → can't scan for you, by design
function ClaimForm({ code }) {
  const { t } = useI18n();
  const { user, adoptSession } = useAuth();
  const navigate = useNavigate();
  const adminSession = user && (user.role === "admin" || user.role === "owner");
  const [mode, setMode] = useState("new"); // new | existing
  const [forceNew, setForceNew] = useState(false); // admin chose "different clinic"
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

  // Admin already signed in on this phone: one tap to add an entrance — but
  // creating a separate new clinic stays one click away.
  if (adminSession && !forceNew) {
    return (
      <form onSubmit={submitAttach} style={{ marginTop: 8 }}>
        <h2>{t("cp.claimExisting")}</h2>
        <p className="muted small">{t("cp.attachSub")}</p>
        {error && <div className="error-box">{error}</div>}
        <button className="btn big" disabled={busy}>{busy ? t("cp.recording") : t("cp.attachBtn")}</button>
        <button type="button" className="btn ghost big" style={{ marginTop: 10 }}
          onClick={() => setForceNew(true)}>
          {t("cp.newInstead")}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={mode === "new" ? submitNew : submitAttach} style={{ textAlign: "left", marginTop: 8 }}>
      <h2 style={{ textAlign: "center" }}>{t("cp.claimTitle")}</h2>
      <p className="muted small" style={{ textAlign: "center" }}>{t("cp.claimSub")}</p>
      {adminSession ? (
        <p className="small muted" style={{ textAlign: "center" }}>
          <a href="#attach" onClick={(e) => { e.preventDefault(); setForceNew(false); }}>
            ← {t("cp.claimExisting")}
          </a>
        </p>
      ) : (
        <div className="seg" style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
          <button type="button" className={mode === "new" ? "active" : ""} style={{ flex: 1 }}
            onClick={() => setMode("new")}>{t("cp.claimNew")}</button>
          <button type="button" className={mode === "existing" ? "active" : ""} style={{ flex: 1 }}
            onClick={() => setMode("existing")}>{t("cp.claimExisting")}</button>
        </div>
      )}
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

// Today's in/out pairs, shown to the member right on the scan page.
function DayHistory({ sessions = [], worked = 0 }) {
  const { t } = useI18n();
  if (!sessions.length) return null;
  return (
    <div className="history" style={{ marginTop: 14 }}>
      <div className="menu-sec" style={{ margin: "0 0 6px" }}>{t("cp.today")}</div>
      {sessions.map((s) => (
        <div className="history-row" key={s.id}>
          <span>{fmtTime(s.clock_in)}</span>
          <span className="history-arrow">→</span>
          <span className={s.clock_out ? "" : "muted"}>{s.clock_out ? fmtTime(s.clock_out) : "…"}</span>
          <span className="history-dur muted">
            {s.clock_out ? fmtMin(s.worked_minutes ?? 0) : t("status.working")}
          </span>
        </div>
      ))}
      <div className="history-total">{t("cp.workedToday", { dur: fmtMin(worked) })}</div>
    </div>
  );
}

// Only a real navigation to the tag URL counts as a scan — that is what an
// NFC tap produces. A refresh or back/forward must never record anything.
const FRESH_SCAN = (() => {
  try { const n = performance.getEntriesByType("navigation")[0]; return !n || n.type === "navigate"; }
  catch { return true; }
})();

export default function Checkpoint() {
  const { code } = useParams();
  const { user, adoptSession } = useAuth();
  const { t } = useI18n();
  const [challenge, setChallenge] = useState(null);
  const [checkpoint, setCheckpoint] = useState(null);
  const [today, setToday] = useState(null);
  const [goalMin, setGoalMin] = useState(480);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { name, did, time, worked, review }
  const [busy, setBusy] = useState(false);
  const [unclaimed, setUnclaimed] = useState(false);
  // Unlinked phone: "choose" → "join" (new account) or "link" (my phone);
  // "wait" while an admin decides; "replaced" when this phone was swapped out.
  const [mode, setMode] = useState(() => {
    try { const m = sessionStorage.getItem("tt_cp_mode"); sessionStorage.removeItem("tt_cp_mode"); return m || "choose"; }
    catch { return "choose"; }
  });
  const [form, setForm] = useState({ first_name: "", last_name: "" });
  const [wait, setWait] = useState(null); // { status, kind, first_name, replaces }
  const [replaced, setReplaced] = useState(null);
  const [welcome, setWelcome] = useState(null); // trusted phone, signed out

  const isEmployee = user && user.role === "employee";
  const isStaffAdmin = user && user.role !== "employee";
  const trusted = !isEmployee || user.this_phone_trusted !== false;
  const issuedAt = useRef(0);
  // A phone linked to someone at a different clinic than this tag's.
  const wrongClinic = !!(user && checkpoint && checkpoint.organization_id &&
    checkpoint.organization_id !== user.organization_id);

  const fetchChallenge = async () => {
    setError("");
    try {
      const d = await api(`/checkpoint/${code}`);
      if (d.unclaimed) { setUnclaimed(true); return null; }
      setChallenge(d.challenge); setCheckpoint(d.checkpoint);
      issuedAt.current = Date.now();
      return d.challenge;
    } catch (e) {
      setError(e.message);
      return null;
    }
  };

  useEffect(() => { fetchChallenge(); }, [code]);
  useEffect(() => {
    if (user) api("/me").then((d) => { setToday(d.today); if (d.goal_min) setGoalMin(d.goal_min); }).catch(() => {});
  }, [user]);

  // A member session on this phone without a reload: keeps FRESH_SCAN true,
  // so the buttons work right after linking or resuming.
  const takeSession = async (session) => {
    setToken(session);
    try { localStorage.removeItem("taptime_link"); } catch {}
    const me = await api("/me");
    adoptSession(me.user);
  };

  // Unlinked phone with a request in flight: ask how it went. The first
  // approved answer carries the member session. Otherwise: is this still
  // someone's trusted phone (signed out), or was it replaced?
  useEffect(() => {
    if (user) return;
    let stored = null;
    try { stored = localStorage.getItem("taptime_link"); } catch {}
    if (stored) {
      api(`/checkpoint/link/${stored}`).then(async (d) => {
        if (d.session) { await takeSession(d.session); return; }
        if (d.status === "unknown") { try { localStorage.removeItem("taptime_link"); } catch {} return; }
        setWait(d); setMode("wait");
      }).catch(() => {});
      return;
    }
    api("/phone-status").then((d) => {
      if (d.trusted) { setWelcome(d); setMode("welcome"); }
      else if (d.replaced) { setReplaced(d); setMode("replaced"); }
    }).catch(() => {});
  }, [user]);

  const resume = async () => {
    setBusy(true); setError("");
    try {
      const d = await api("/checkpoint/resume", { method: "POST" });
      await takeSession(d.session);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const showResult = (d, extra = {}) => {
    const att = d.today.attendance;
    setToday(d.today);
    setResult({
      name: d.user?.first_name || user?.first_name,
      did: d.did,
      time: d.did === "out" ? fmtTime(att?.clock_out) : fmtTime(att?.clock_in),
      worked: d.today.worked_min,
      sessions: d.today.sessions || [],
      review: d.today.status === "requires_review",
      ...extra,
    });
  };

  const tapError = (e) => {
    if (e.code === "phone_not_trusted") setError(t("cp.notTrusted"));
    else setError(e.status === 410 ? t("cp.rescanOut") : e.message);
  };

  // In and out are both explicit button presses, and both need the challenge
  // this page load received from a real scan, within its 2-minute life. No
  // silent re-issue — a refreshed tab or a bookmark can't record anything.
  const tap = async (want) => {
    if (!FRESH_SCAN || Date.now() - issuedAt.current > 110 * 1000) { setError(t("cp.staleScan")); return; }
    setBusy(true); setError("");
    try {
      const geo = await getGeo();
      const d = await api("/checkpoint/tap", { method: "POST", body: { challenge, geo, action: want } });
      showResult(d);
    } catch (e) {
      tapError(e);
    } finally {
      setBusy(false);
    }
  };

  // "I'm new" / "this is my phone": both end in a request the admin decides.
  const submitRequest = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const d = await api(mode === "join" ? "/checkpoint/join" : "/checkpoint/link", {
        method: "POST", body: { ...form, tag_code: code },
      });
      try { localStorage.setItem("taptime_link", d.link); } catch {}
      setWait({ status: "pending", kind: d.kind, first_name: d.first_name, replaces: !!d.replaces });
      setMode("wait");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const cancelWait = () => {
    try { localStorage.removeItem("taptime_link"); } catch {}
    setWait(null); setError(""); setMode("choose");
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

  // Disconnect this phone: the session cookie is HttpOnly, so the server has
  // to clear it too — otherwise the reload silently signs the same person in.
  const disconnect = async (nextMode = "choose") => {
    try { await api("/auth/logout", { method: "POST" }); } catch {}
    setToken(null);
    try { sessionStorage.setItem("tt_cp_mode", nextMode); } catch {}
    window.location.reload();
  };

  const s = today?.status;
  const unlinked = !result && !user && checkpoint;

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

        {/* -------- scan result + today's history -------- */}
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
            <div className="clock-hero">
              <Clock />
              <DayProgress sessions={result.sessions} goalMin={goalMin} />
            </div>
            <DayHistory sessions={result.sessions} worked={result.worked} />
            {result.review && <p className="small muted">{t("cp.reviewNote")}</p>}
            {/* Never a Clock out button here: this page's scan was just used. */}
            {result.did !== "out" && <p className="small muted">{t("cp.scanToOut")}</p>}
          </>
        )}

        {/* -------- linked phone, but this tag is another clinic's -------- */}
        {!result && user && checkpoint && wrongClinic && (
          <>
            <div className="error-box" style={{ textAlign: "left" }}>
              {t("cp.wrongClinic", { name: user.first_name, mine: user.clinic || "?", clinic: checkpoint.clinic })}
            </div>
            <button className="btn big" onClick={() => disconnect("link")}>
              {t("cp.wrongClinicAction", { clinic: checkpoint.clinic })}
            </button>
          </>
        )}

        {/* -------- member session on a phone that is NOT their trusted one -------- */}
        {!result && isEmployee && checkpoint && !wrongClinic && !trusted && (
          <>
            <div className="error-box" style={{ textAlign: "left" }}>{t("cp.notTrusted")}</div>
            <button className="btn big" onClick={() => disconnect("link")}>{t("cp.linkAgain")}</button>
          </>
        )}

        {/* -------- trusted phone at its own clinic: one explicit button -------- */}
        {!result && isEmployee && checkpoint && today && !wrongClinic && trusted && (() => {
          const open = today.status === "working" || today.status === "break";
          const att = today.attendance;
          return (
            <>
              <h2 style={{ marginTop: 6 }}>{t("cp.hi", { name: user.first_name })}</h2>
              <div className="clock-hero">
                <span className={`pill ${open ? today.status : "no_shift"}`}>{t(open ? `status.${today.status}` : "cp.stopped")}</span>
                <Clock />
                <div className="sub">
                  {att?.clock_in
                    ? `${t("dash.in", { time: fmtTime(att.clock_in) })}${att.clock_out ? ` · ${t("dash.out", { time: fmtTime(att.clock_out) })}` : ""} · ${t("dash.workedFor", { dur: fmtMin(today.worked_min) })}`
                    : t("cp.nothingYet")}
                </div>
                <DayProgress sessions={today.sessions || []} goalMin={goalMin} />
                {FRESH_SCAN ? (
                  <div className="clock-actions">
                    <button className="btn" disabled={busy} onClick={() => tap(open ? "out" : "in")}>
                      {busy ? t("cp.recording") : t(open ? "dash.clockOut" : "dash.clockIn")}
                    </button>
                  </div>
                ) : (
                  <p className="small muted" style={{ marginTop: 16 }}>{t("cp.staleScan")}</p>
                )}
              </div>
              <DayHistory sessions={today.sessions} worked={today.worked_min} />
            </>
          );
        })()}

        {/* -------- admin/manager session: explicit buttons -------- */}
        {!result && isStaffAdmin && today && checkpoint && !wrongClinic && (
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

        {/* -------- unlinked phone: waiting for the admin -------- */}
        {unlinked && mode === "wait" && wait && (
          <>
            {wait.status === "pending" && (
              <div className="ok-box" style={{ textAlign: "left" }}>
                {t(wait.kind === "join" ? "cp.pending" : "cp.waitLink", { name: wait.first_name })}
                {wait.replaces && <div style={{ marginTop: 6 }}>{t("cp.waitReplace")}</div>}
              </div>
            )}
            {wait.status === "rejected" && <div className="error-box">{t("cp.linkRejected")}</div>}
            <p className="small muted" style={{ marginTop: 12 }}>
              <a href="#cancel" onClick={(e) => { e.preventDefault(); cancelWait(); }}>
                {wait.status === "pending" ? t("cp.cancelWait") : t("cp.startOver")}
              </a>
            </p>
          </>
        )}

        {/* -------- trusted phone, signed out: pick the session back up -------- */}
        {unlinked && mode === "welcome" && welcome && (
          <>
            <h2 style={{ marginTop: 4 }}>{t("cp.welcomeBack", { name: welcome.first_name })}</h2>
            <p className="muted small" style={{ marginBottom: 14 }}>{t("cp.welcomeSub")}</p>
            <button className="btn big" disabled={busy} onClick={resume}>{t("cp.continueAs", { name: welcome.first_name })}</button>
            <p className="small muted" style={{ marginTop: 12 }}>
              <a href="#other" onClick={(e) => { e.preventDefault(); setMode("choose"); }}>{t("cp.someoneElse")}</a>
            </p>
          </>
        )}

        {/* -------- this phone was replaced by another one -------- */}
        {unlinked && mode === "replaced" && replaced && (
          <>
            <div className="error-box" style={{ textAlign: "left" }}>{t("cp.replaced", { name: replaced.first_name })}</div>
            <button className="btn big" onClick={() => { setError(""); setMode("link"); }}>{t("cp.linkAgain")}</button>
            <p className="small muted" style={{ marginTop: 12 }}>
              <a href="#other" onClick={(e) => { e.preventDefault(); setMode("choose"); }}>{t("cp.someoneElse")}</a>
            </p>
          </>
        )}

        {/* -------- unlinked phone: first time here, or already a member? -------- */}
        {unlinked && mode === "choose" && (
          <>
            <h2 style={{ marginTop: 4 }}>{t("cp.chooseTitle")}</h2>
            <p className="muted small" style={{ marginBottom: 18 }}>{t("cp.chooseSub", { clinic: checkpoint.clinic })}</p>
            <button className="btn big" onClick={() => { setError(""); setMode("join"); }}>{t("cp.chooseNew")}</button>
            <button className="btn ghost big" style={{ marginTop: 10 }} onClick={() => { setError(""); setMode("link"); }}>
              {t("cp.chooseHave")}
            </button>
          </>
        )}

        {/* -------- name form: new account, or link this phone -------- */}
        {unlinked && (mode === "join" || mode === "link") && (
          <form onSubmit={submitRequest} style={{ textAlign: "left", marginTop: 8 }}>
            <h2 style={{ textAlign: "center" }}>{t(mode === "join" ? "cp.joinTitle" : "cp.linkTitle")}</h2>
            <p className="muted small" style={{ textAlign: "center" }}>{t(mode === "join" ? "cp.joinSub" : "cp.linkSub")}</p>
            <div className="grid2">
              <label className="field"><span>{t("emp.first")}</span>
                <input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} required autoFocus />
              </label>
              <label className="field"><span>{t("emp.last")}</span>
                <input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
              </label>
            </div>
            <button className="btn big" disabled={busy}>
              {busy ? t("cp.recording") : t(mode === "join" ? "cp.joinBtn" : "cp.linkBtn")}
            </button>
            <p className="small muted" style={{ textAlign: "center", marginTop: 12 }}>
              <a href="#other" onClick={(e) => { e.preventDefault(); setError(""); setMode(mode === "join" ? "link" : "join"); }}>
                {t(mode === "join" ? "cp.chooseHave" : "cp.newHere")}
              </a>
            </p>
          </form>
        )}

        {isEmployee && trusted && (
          <p className="small" style={{ marginTop: 16 }}>
            <Link to="/">{t("cp.myHistory")} →</Link>
          </p>
        )}
        {user && (
          <p className="small muted" style={{ marginTop: 6 }}>
            <a href="#notme" onClick={(e) => { e.preventDefault(); disconnect("choose"); }}>
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
