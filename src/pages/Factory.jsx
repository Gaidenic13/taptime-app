import React, { useCallback, useEffect, useRef, useState } from "react";
import Credentials from "../components/Credentials.jsx";
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

// Two-step delete: first click asks, second click acts — no misclick risk.
function RemoveBtn({ onConfirm }) {
  const { t } = useI18n();
  const [arming, setArming] = useState(false);
  useEffect(() => {
    if (!arming) return;
    const timer = setTimeout(() => setArming(false), 5000); // disarm if ignored
    return () => clearTimeout(timer);
  }, [arming]);

  if (!arming) {
    return <button className="btn ghost small" onClick={() => setArming(true)}>{t("common.remove")}</button>;
  }
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className="small" style={{ fontWeight: 600 }}>{t("factory.sure")}</span>
      <button className="btn danger small" onClick={onConfirm}>{t("factory.confirm")}</button>
      <button className="btn subtle small" onClick={() => setArming(false)}>{t("common.cancel")}</button>
    </span>
  );
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
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [inventory, setInventory] = useState({ total: 0, pages: 1, counts: { total: 0, activated: 0, unclaimed: 0 } });
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState([]); // codes minted in this session, shown on top with QR

  const load = useCallback(async (overrides = {}) => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ search, status, page, ...overrides });
      const d = await factoryApi(`/tags?${params}`);
      if (id !== requestId.current) return;
      setTags(d.tags); setInventory(d); setPage(d.page); setAuthed(true); setError("");
    } catch (e) {
      if (id !== requestId.current) return;
      if (e.status === 401) { setAuthed(false); localStorage.removeItem(KEY_STORAGE); }
      setError(e.message);
    } finally { if (id === requestId.current) setLoading(false); }
  }, [search, status, page]);

  useEffect(() => {
    if (localStorage.getItem(KEY_STORAGE)) load();
  }, [load]);

  const unlock = (e) => {
    e.preventDefault();
    localStorage.setItem(KEY_STORAGE, keyInput.trim());
    load();
  };
  const lock = () => {
    ++requestId.current;
    localStorage.removeItem(KEY_STORAGE);
    setAuthed(false); setKeyInput(""); setTags([]); setFresh([]); setError(""); setLoading(false);
  };

  const mint = async () => {
    setBusy(true); setError("");
    try {
      const d = await factoryApi("/tags", { method: "POST", body: { count: Number(count) || 1 } });
      setFresh(d.codes);
      setSearchInput(""); setSearch(""); setStatus("all"); setPage(1);
      await load({ search: "", status: "all", page: 1 });
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
          <button className="btn big" disabled={loading}>{loading ? "…" : t("login.signin")}</button>
        </form>
      </div>
    );
  }

  return (
    <div className="main" style={{ margin: "0 auto", maxWidth: 860 }}>
      <div className="topline">
        <div className="brand" style={{ flex: 1 }}><span className="brand-mark">T</span>{t("factory.title")}</div>
        <LangSwitch />
        <button className="btn subtle small" disabled={busy} onClick={lock}>{t("factory.lock")}</button>
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
        <div className="stats">
          {[["total", "factory.total"], ["activated", "factory.activated"], ["unclaimed", "factory.unclaimed"]].map(([key, label]) =>
            <div className="stat" key={key}><div className="n">{inventory.counts[key]}</div><div className="l">{t(label)}</div></div>)}
        </div>
        <form className="row" style={{ marginBottom: 12 }} onSubmit={(e) => { e.preventDefault(); setSearch(searchInput.trim()); setPage(1); }}>
          <label className="field" style={{ flex: 1, minWidth: 180 }}><span>{t("factory.search")}</span>
            <input type="search" value={searchInput} maxLength={120} onChange={(e) => setSearchInput(e.target.value)} />
          </label>
          <button className="btn small" disabled={loading}>{t("common.search")}</button>
          <label className="field"><span>{t("factory.filter")}</span>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="all">{t("factory.all")}</option><option value="activated">{t("factory.activated")}</option><option value="unclaimed">{t("factory.unclaimed")}</option>
            </select>
          </label>
          <button type="button" className="btn subtle small" disabled={loading} onClick={() => load()}>{t("common.refresh")}</button>
        </form>
        {loading && <p role="status">{t("common.loading")}</p>}
        {!loading && tags.length === 0 && <div className="empty">{t("factory.noResults")}</div>}
        {tags.map((tg) => (
          <div className="list-item" key={tg.id}>
          <div className="spread">
            <div style={{ minWidth: 0 }}>
              <div style={{ wordBreak: "break-all", fontWeight: 600, fontSize: 13 }}>{urlFor(tg.code)}</div>
              <div className="small muted">{t("factory.created")}: {fmtDateTime(tg.created_at)}</div>
              {tg.claimed_at && <div className="small muted">{t("factory.activated")}: {fmtDateTime(tg.claimed_at)}</div>}
            </div>
            <div className="row">
              {tg.clinic
                ? <span className="pill working">{tg.clinic}{tg.entrance ? ` · ${tg.entrance}` : ""}</span>
                : <span className="pill pending">{t("factory.unclaimed")}</span>}
              <CopyBtn text={urlFor(tg.code)} />
              {!tg.clinic && (
                <RemoveBtn
                  onConfirm={async () => {
                    try { await factoryApi(`/tags/${tg.id}`, { method: "DELETE" }); load(); }
                    catch (e) { setError(e.message); }
                  }}
                />
              )}
            </div>
          </div>
          <details open style={{ marginTop: 12 }}>
            <summary>{t("cred.title")}</summary>
            <p className="small muted">{t(tg.organization_id ? "cred.note" : "cred.unclaimed")}</p>
            {tg.organization_id && !tg.accounts.length && <p>{t("cred.empty")}</p>}
            {tg.accounts.map((account) => <Credentials key={account.id} account={account} onSave={async (body) => {
              const d = await factoryApi(`/tags/${tg.id}/credentials/${account.id}`, { method: "PUT", body });
              setTags((prev) => prev.map((tag) => ({ ...tag, accounts: tag.accounts.map((a) => a.id === d.account.id ? d.account : a) })));
            }} />)}
          </details>
          </div>
        ))}
        <div className="spread" style={{ marginTop: 16 }}>
          <span className="small muted">{t("factory.page", { page, pages: inventory.pages, total: inventory.total })}</span>
          <div className="row">
            <button className="btn subtle small" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>{t("common.previous")}</button>
            <button className="btn subtle small" disabled={loading || page >= inventory.pages} onClick={() => setPage(page + 1)}>{t("common.next")}</button>
          </div>
        </div>
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
