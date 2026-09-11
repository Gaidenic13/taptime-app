// Quote every cell, preserve Romanian characters in Excel, and keep user text
// from being interpreted as a spreadsheet formula.
export function buildCsv(headers, rows) {
  const cell = (value) => {
    let text = String(value ?? "");
    if (typeof value === "string" && /^[\s\uFEFF]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return "\uFEFF" + [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}

export function downloadCsv(filename, headers, rows) {
  const url = URL.createObjectURL(new Blob([buildCsv(headers, rows)], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
