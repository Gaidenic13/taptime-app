// All date handling is local-time based: dates as YYYY-MM-DD, times as HH:MM.

export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function hhmm(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Combine a YYYY-MM-DD date and HH:MM local time into an ISO string.
export function dateTimeIso(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm).toISOString();
}

export function minutesBetween(isoA, isoB) {
  return Math.round((new Date(isoB) - new Date(isoA)) / 60000);
}

export function shiftMinutes(startTime, endTime) {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

export function breakMinutes(breaks, fallbackEnd = nowIso()) {
  return breaks.reduce(
    (sum, b) => sum + Math.max(0, minutesBetween(b.start, b.end || fallbackEnd)),
    0
  );
}

// Worked minutes for an attendance row (net of breaks). Open attendance counts up to now.
export function workedMinutes(att, breaks) {
  if (!att?.clock_in) return 0;
  const end = att.clock_out || nowIso();
  return Math.max(0, minutesBetween(att.clock_in, end) - breakMinutes(breaks, end));
}

export function fmtMinutes(min) {
  const h = Math.floor(Math.abs(min) / 60);
  const m = Math.abs(min) % 60;
  return `${min < 0 ? "-" : ""}${h}h ${String(m).padStart(2, "0")}m`;
}

// Business days (Mon-Fri) between two YYYY-MM-DD dates, inclusive.
export function businessDays(startStr, endStr) {
  const start = new Date(startStr + "T00:00:00");
  const end = new Date(endStr + "T00:00:00");
  let count = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return todayStr(d);
}

// Monday of the week containing dateStr.
export function mondayOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const dow = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - dow);
  return todayStr(d);
}
