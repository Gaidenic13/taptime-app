import React, { useEffect, useState } from "react";
import { api, fmtTime, fmtMin } from "../api.js";
import { useAuth } from "../App.jsx";
import { useI18n, LangSwitch } from "../i18n.jsx";

// Team members don't use the app — they just tap the tag. If an activated
// member opens the app anyway, they get this single card: today's scans and
// a reminder of how the product works. No menus, no login flows.
export default function MemberHome() {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const [today, setToday] = useState(null);

  useEffect(() => {
    api("/me").then((d) => setToday(d.today)).catch(() => {});
  }, []);

  return (
    <div className="login-wrap">
      <div className="corner-lang"><LangSwitch /></div>
      <div className="card login-card">
        <div className="brand"><span className="brand-mark">T</span>TapTime</div>
        <h2 style={{ marginTop: 8 }}>{t("dash.hi", { name: user.first_name })}</h2>
        {today && (
          <>
            <span className={`pill ${today.status}`}>{t(`status.${today.status}`)}</span>
            {today.sessions?.length > 0 && (
              <div style={{ marginTop: 14 }}>
                {today.sessions.map((s) => (
                  <div className="list-item" key={s.id} style={{ fontWeight: 600 }}>
                    {fmtTime(s.clock_in)} → {s.clock_out ? fmtTime(s.clock_out) : "…"}
                  </div>
                ))}
                <p style={{ marginTop: 10, fontWeight: 600 }}>{t("cp.workedToday", { dur: fmtMin(today.worked_min) })}</p>
              </div>
            )}
          </>
        )}
        <p className="small muted" style={{ marginTop: 14 }}>{t("member.note")}</p>
        <button className="btn subtle" style={{ marginTop: 10 }} onClick={logout}>{t("nav.logout")}</button>
      </div>
    </div>
  );
}
