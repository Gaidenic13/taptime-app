import React, { useEffect, useState } from "react";
import QRCode from "qrcode";
import { fmtDateTime } from "../api.js";
import { I18nProvider, useI18n, LangSwitch } from "../i18n.jsx";

// Vendor-only production floor (/factory): mint a new TapTime per physical
// unit, copy/write its URL to the tag, and watch inventory status — each row
// flips from "unclaimed" to the clinic that claimed it. Guarded by the
// factory key (FACTORY_KEY on the server; "dev-factory" locally).
const KEY_STORAGE = "taptime_factory_key";

async function factoryApi(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api/factory${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Factory-Key": localStorage.getItem(KEY_STORAGE) || "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `Request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data;
}

function QrImg({ url }) {
  const [src, setSrc] = useState("");
  useEffect(() => { QRCode.toDataURL(url, { width: 300, margin: 1 }).then(setSrc); }, [url]);
  return src ? <img className="qr-box" src={src} alt={`QR ${url}`} width={92} height={92} /> : null;
}

function CopyBtn({ text }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { /* clipboard unavailable */ }
  };
  return <button className="btn subtle small" onClick={copy}>{copied ? t("setup.copied") : t("setup.copy")}</button>;
}

function FactoryInner() {
  const { t } = useI18n();
  const [authed, setAuthed] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [tags, setTags] = useState([]);
  const [count, setCount] = useState(1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState([]); // codes minted in this session, shown on top with QR

  const load = () =>
    factoryApi("/tags")
      .then((d) => { setTags(d.tags); setAuthed(true); setError(""); })
      .catch((e) => {
        if (e.status === 401) { setAuthed(false); localStorage.removeItem(KEY_STORAGE); }
        else setError(e.message);
      });

  useEffect(() => {
    if (localStorage.getItem(KEY_STORAGE)) load();
  }, []);

  const unlock = (e) => {
    e.preventDefault();
    localStorage.setItem(KEY_STORAGE, keyInput.trim());
    load().catch(() => {});
  };

  const mint = async () => {
    setBusy(true); setError("");
    try {
      const d = await factoryApi("/tags", { method: "POST", body: { count: Number(count) || 1 } });
      setFresh(d.codes);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const origin = window.location.origin;
  const urlFor = (code) => `${origin}/checkpoint/${code}`;

  if (!authed) {
    return (
      <div className="login-wrap">
        <div className="corner-lang"><LangSwitch /></div>
        <form className="card login-card" onSubmit={unlock}>
          <div className="brand"><span className="brand-mark">T</span>{t("factory.title")}</div>
          <label className="field" style={{ textAlign: "left", marginTop: 12 }}>
            <span>{t("factory.key")}</span>
            <input type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} required autoFocus />
          </label>
          {error && <div className="error-box">{error}</div>}
          <button className="btn big">{t("login.signin")}</button>
        </form>
      </div>
    );
  }

  return (
    <div className="main" style={{ margin: "0 auto", maxWidth: 860 }}>
      <div className="topline">
        <div className="brand" style={{ flex: 1 }}><span className="brand-mark">T</span>{t("factory.title")}</div>
        <LangSwitch />
      </div>
      <div className="page-head">
        <h1>{t("factory.heading")}</h1>
        <p>{t("factory.sub")}</p>
      </div>

      <div className="card">
        <div className="row">
          <input type="number" min="1" max="50" value={count} onChange={(e) => setCount(e.target.value)} style={{ width: 90 }} />
          <button className="btn" disabled={busy} onClick={mint}>
            {busy ? "…" : t("factory.mint")}
          </button>
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>

      {fresh.length > 0 && (
        <div className="card tinted">
          <h2>{t("factory.freshTitle")}</h2>
          <p className="small muted">{t("factory.freshSub")}</p>
          {fresh.map((code) => (
            <div className="list-item row" key={code} style={{ alignItems: "flex-start" }}>
              <QrImg url={urlFor(code)} />
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ wordBreak: "break-all", fontWeight: 600, fontSize: 13 }}>{urlFor(code)}</div>
                <div style={{ marginTop: 8 }}><CopyBtn text={urlFor(code)} /></div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>{t("factory.inventory")}</h2>
        {tags.length === 0 && <div className="empty">—</div>}
        {tags.map((tg) => (
          <div className="list-item spread" key={tg.id}>
            <div style={{ minWidth: 0 }}>
              <div style={{ wordBreak: "break-all", fontWeight: 600, fontSize: 13 }}>{urlFor(tg.code)}</div>
              <div className="small muted">{fmtDateTime(tg.created_at)}</div>
            </div>
            <div className="row">
              {tg.clinic
                ? <span className="pill working">{tg.clinic}{tg.entrance ? ` · ${tg.entrance}` : ""}</span>
                : <span className="pill pending">{t("factory.unclaimed")}</span>}
              <CopyBtn text={urlFor(tg.code)} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Rendered outside the app shell (like /terminal), so it carries its own provider.
export default function Factory() {
  return (
    <I18nProvider>
      <FactoryInner />
    </I18nProvider>
  );
}
