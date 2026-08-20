let token = localStorage.getItem("taptime_token") || null;

// Stable per-browser device token — a known-device signal for the risk engine.
let deviceToken = localStorage.getItem("taptime_device") || null;
if (!deviceToken) {
  deviceToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  localStorage.setItem("taptime_device", deviceToken);
}

export function setToken(t) {
  token = t;
  if (t) localStorage.setItem("taptime_token", t);
  else localStorage.removeItem("taptime_token");
}

export async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Device-Token": deviceToken,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Try to get the browser's location quickly; resolve null rather than reject —
// location is a risk signal, never a hard requirement on the client side.
export function getGeo(timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    const timer = setTimeout(() => resolve(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
        });
      },
      () => { clearTimeout(timer); resolve(null); },
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 60000 }
    );
  });
}

// ---- formatting helpers shared across pages (locale follows the language toggle) ----
import { dateLocale } from "./i18n.jsx";

export const fmtMin = (min) => {
  if (min == null) return "—";
  const h = Math.floor(min / 60), m = min % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
};
export const fmtTime = (iso) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
export const fmtDate = (str) =>
  new Date(str + "T00:00:00").toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" });
export const fmtDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString(dateLocale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
export const fmtLongDate = (d = new Date()) =>
  d.toLocaleDateString(dateLocale(), { weekday: "long", day: "numeric", month: "long" });
export const fmtMonth = (month) =>
  new Date(month + "-01T00:00:00").toLocaleDateString(dateLocale(), { month: "long", year: "numeric" });

export const LEAVE_TYPES = ["annual", "medical", "personal", "unpaid", "other"];

export const weekdayNames = () => {
  const base = new Date(2026, 0, 5); // a Monday
  return Array.from({ length: 7 }, (_, i) =>
    new Date(base.getTime() + i * 86400000).toLocaleDateString(dateLocale(), { weekday: "long" })
  );
};
