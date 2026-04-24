// Minimal CSV encoder — RFC 4180 quoting. No dependency because the rules are
// small: quote any field that contains comma/quote/newline, double any
// embedded quotes, terminate rows with CRLF.

export function encodeCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const lines: string[] = [headers.map(csvField).join(',')];
  for (const row of rows) {
    lines.push(row.map((v) => csvField(v)).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v) : v;
  if (s === '') return '';
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
