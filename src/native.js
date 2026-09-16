// The native (Capacitor / iOS) side of the web app. On the web every export is
// a harmless no-op, so the pages never need to know where they run.
//  · identity: the device token and the session live in the iOS Keychain, so
//    the "trusted phone" survives reinstalls and can't be wiped like localStorage
//  · scans: in the app a scan is "the app was opened by a tag URL" (deep link
//    or an in-app Core NFC read), not a browser navigation
import { Capacitor, registerPlugin } from "@capacitor/core";
import { setDeviceToken, setToken, onTokenChange } from "./api.js";

export const isNative = Capacitor.isNativePlatform();
const Native = isNative ? registerPlugin("TapTimeNative") : null;

const secureGet = async (key) => {
  try { return (await Native.getSecure({ key })).value ?? null; } catch { return null; }
};
const secureSet = async (key, value) => {
  try { await Native.setSecure({ key, value: value ?? "" }); } catch { /* keychain unavailable */ }
};

// Called once before the first render. Restores identity from the Keychain
// (creating the device token on first launch) and mirrors later changes back.
export async function initNative() {
  if (!isNative) return;
  document.documentElement.classList.add("native", Capacitor.getPlatform());
  // Uncaught errors reach the native console (Capacitor forwards console.*),
  // which is the only place to see them without a Web Inspector attached.
  window.addEventListener("error", (e) => console.error("[uncaught]", e.message, e.filename, e.lineno));
  window.addEventListener("unhandledrejection", (e) => console.error("[unhandled]", e.reason?.message || String(e.reason)));
  // Keychain first; an empty read falls back to the token already in web
  // storage (an upgrade, or a transient Keychain failure) before minting a
  // new identity — a new token would silently un-trust this phone.
  let device = await secureGet("device");
  if (!device) {
    device = localStorage.getItem("taptime_device")
      || Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");
    await secureSet("device", device);
  }
  setDeviceToken(device);
  const session = await secureGet("session");
  if (session) setToken(session);
  onTokenChange((t) => secureSet("session", t || ""));
  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: Style.Light }); // dark text on the greige ground
  } catch { /* plugin missing */ }
}

// The launch image stays up until React has painted the first screen.
export async function hideSplash() {
  if (!isNative) return;
  try { const { SplashScreen } = await import("@capacitor/splash-screen"); await SplashScreen.hide({ fadeOutDuration: 200 }); } catch { /* plugin missing */ }
}

// -------- scans: a tag URL opened the app, or the user scanned from inside
const scans = new Map(); // checkpoint code → timestamp of the tag event
export function markScan(code) { scans.set(code, Date.now()); }
// Fresh = a tag event for this code within the challenge's life (2 minutes).
export function consumeScan(code) {
  const at = scans.get(code);
  if (!at) return false;
  scans.delete(code);
  return Date.now() - at < 110 * 1000;
}
// "/checkpoint/<code>" from either the custom scheme or the https link.
export function checkpointPathFromUrl(url) {
  try {
    const u = new URL(url);
    const path = u.protocol === "taptime:" ? `/${u.host}${u.pathname}` : u.pathname;
    const m = path.match(/\/checkpoint\/([A-Za-z0-9_-]+)/);
    return m ? { path: `/checkpoint/${m[1]}`, code: m[1] } : null;
  } catch { return null; }
}
// Deep links while running (cold-start links arrive here too, via getLaunchUrl).
export async function listenForTagLinks(onCheckpoint) {
  if (!isNative) return () => {};
  const { App } = await import("@capacitor/app");
  // On a cold start the launch URL can arrive both as the launch URL and as
  // an appUrlOpen event; the second copy must not spend the scan.
  let last = { url: null, at: 0 };
  const handle = (url) => {
    const now = Date.now();
    if (url === last.url && now - last.at < 3000) return;
    last = { url, at: now };
    const cp = checkpointPathFromUrl(url);
    if (cp) { markScan(cp.code); onCheckpoint(cp.path); }
  };
  const sub = await App.addListener("appUrlOpen", ({ url }) => handle(url));
  // getLaunchUrl() answers with the launch URL for the app's whole lifetime,
  // so a web view reload would replay it as a new tap: handle it once.
  try {
    const launch = await App.getLaunchUrl();
    const seen = sessionStorage.getItem("tt_launch_url");
    if (launch?.url && launch.url !== seen) { sessionStorage.setItem("tt_launch_url", launch.url); handle(launch.url); }
  } catch { /* none */ }
  return () => sub.remove();
}

// In-app Core NFC read (phones without background tag reading, or when the
// user prefers a button). Resolves the checkpoint path or throws an Error
// with .code: nfc_unavailable | nfc_cancelled | nfc_no_url | nfc_not_taptime.
export async function scanTag({ prompt } = {}) {
  if (!isNative) { const e = new Error("Not available in the browser"); e.code = "nfc_unavailable"; throw e; }
  const { available } = await Native.nfcAvailable();
  if (!available) { const e = new Error("NFC reading isn't available on this device"); e.code = "nfc_unavailable"; throw e; }
  let url;
  try {
    ({ url } = await Native.scanNfc({ message: prompt || "Hold your iPhone near the TapTime tag" }));
  } catch (err) {
    const e = new Error(err?.message || "Scan failed"); e.code = err?.code || "nfc_cancelled"; throw e;
  }
  const cp = checkpointPathFromUrl(url);
  if (!cp) { const e = new Error("That tag isn't a TapTime tag"); e.code = "nfc_not_taptime"; throw e; }
  markScan(cp.code);
  return cp.path;
}
// One user-facing sentence per scan outcome, or null for a quiet dismissal.
export function scanErrorKey(e) {
  return { nfc_unavailable: "native.scanUnavailable", nfc_no_url: "native.scanNoUrl", nfc_not_taptime: "native.scanNotTaptime" }[e?.code]
    || (e?.code === "nfc_cancelled" ? null : "native.scanFailed");
}

export async function haptic(kind = "success") {
  if (!isNative) return;
  try {
    const { Haptics, NotificationType, ImpactStyle } = await import("@capacitor/haptics");
    if (kind === "tap") await Haptics.impact({ style: ImpactStyle.Medium });
    else await Haptics.notification({ type: kind === "error" ? NotificationType.Error : NotificationType.Success });
  } catch { /* no haptics */ }
}
