import React, { useEffect, useState } from "react";
import { fmtMin } from "../api.js";
import { useI18n } from "../i18n.jsx";

// Today's worked time against the clinic's daily goal, ticking live while a
// session is open — the small "game" of filling the bar by the end of the day.
const liveMinutes = (sessions) => sessions.reduce((sum, s) => {
  if (s.clock_out) return sum + (s.worked_minutes ?? 0);
  const elapsed = (Date.now() - new Date(s.clock_in).getTime()) / 60000 - (s.break_minutes || 0);
  return sum + Math.max(0, elapsed);
}, 0);

export default function DayProgress({ sessions = [], goalMin = 480 }) {
  const { t } = useI18n();
  const [done, setDone] = useState(() => liveMinutes(sessions));
  useEffect(() => {
    setDone(liveMinutes(sessions));
    if (!sessions.some((s) => !s.clock_out)) return undefined;
    const timer = setInterval(() => setDone(liveMinutes(sessions)), 1000);
    return () => clearInterval(timer);
  }, [sessions]);

  if (!goalMin) return null;
  const pct = Math.min(100, Math.round((done / goalMin) * 100));
  const reached = done >= goalMin;
  return (
    <div className={`goal${reached ? " done" : ""}`}>
      <div className="goal-row">
        <span>{t("goal.of", { done: fmtMin(Math.floor(done)), target: fmtMin(goalMin) })}</span>
        <span className="muted">{pct}%</span>
      </div>
      <div className="goal-bar"><div className="goal-fill" style={{ width: `${pct}%` }} /></div>
      <div className="small muted" style={{ marginTop: 6 }}>
        {reached ? t("goal.reached") : t("goal.left", { left: fmtMin(Math.ceil(goalMin - done)) })}
      </div>
    </div>
  );
}
