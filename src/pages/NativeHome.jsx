import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, setToken } from "../api.js";
import { useAuth } from "../App.jsx";
import { useI18n, LangSwitch } from "../i18n.jsx";
import { scanTag, scanErrorKey } from "../native.js";

// The iOS app's front door when nobody is signed in on this phone. Workers
// never sign in: they tap the tag at the door (background NFC opens the app
// straight on the scan page) or press "Scan" here. Managers sign in below.
export default function NativeHome() {
  const { t } = useI18n();
  const { adoptSession } = useAuth();
  const navigate = useNavigate();
  const [welcome, setWelcome] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  // Signed out on a trusted phone: the device itself is the credential.
  useEffect(() => {
    api("/phone-status").then((d) => { if (d.trusted) setWelcome(d); }).catch(() => {});
  }, []);

  const resume = async () => {
    setBusy(true); setNote("");
    try {
      const d = await api("/checkpoint/resume", { method: "POST" });
      setToken(d.session);
      const me = await api("/me");
      adoptSession(me.user);
    } catch (e) {
      setNote(e.message);
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    setBusy(true); setNote("");
    try {
      navigate(await scanTag({ prompt: t("native.nfcPrompt") }));
    } catch (e) {
      const key = scanErrorKey(e);
      if (key) setNote(t(key));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="corner-lang"><LangSwitch /></div>
      <div className="card login-card">
        <div className="brand"><span className="brand-mark">T</span>TapTime</div>
        {welcome ? (
          <>
            <h2 style={{ marginTop: 8 }}>{t("cp.welcomeBack", { name: welcome.first_name })}</h2>
            <p className="muted small">{t("cp.welcomeSub")}</p>
            <button className="btn big" disabled={busy} onClick={resume}>{t("cp.continueAs", { name: welcome.first_name })}</button>
          </>
        ) : (
          <>
            <h2 style={{ marginTop: 8 }}>{t("native.homeTitle")}</h2>
            <p className="muted small">{t("native.homeSub")}</p>
          </>
        )}
        <button className="btn ghost big" style={{ marginTop: 10 }} disabled={busy} onClick={scan}>{t("native.scan")}</button>
        {note && <div className="error-box" style={{ marginTop: 12 }}>{note}</div>}
        <p className="small muted" style={{ marginTop: 22 }}>
          <Link to="/login">{t("native.manager")}</Link>
        </p>
      </div>
    </div>
  );
}
