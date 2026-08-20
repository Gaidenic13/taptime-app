import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDateTime } from "../api.js";
import { useI18n } from "../i18n.jsx";

const BellIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
);

export default function Bell() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState([]);
  const ref = useRef(null);

  const load = () =>
    api("/notifications").then((d) => { setUnread(d.unread); setItems(d.notifications); }).catch(() => {});

  useEffect(() => {
    load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) {
      await api("/notifications/read-all", { method: "POST" }).catch(() => {});
      setUnread(0);
    }
  };

  return (
    <div className="bell-wrap" ref={ref}>
      <button className="bell-btn" onClick={toggle} aria-label={t("notif.title")}>
        <BellIcon />
        {unread > 0 && <span className="bell-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel">
          <h3>{t("notif.title")}</h3>
          {items.length === 0 && <div className="empty">{t("notif.empty")}</div>}
          {items.map((n) => (
            <Link key={n.id} to={n.link || "#"} className="list-item bell-item" onClick={() => setOpen(false)}>
              <strong>{n.title}</strong>
              {n.body && <div className="small muted">{n.body}</div>}
              <div className="small muted">{fmtDateTime(n.created_at)}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
