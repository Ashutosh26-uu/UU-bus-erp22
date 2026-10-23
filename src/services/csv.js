/** Minimal RFC-4180 CSV parser (quotes, escaped quotes, CRLF). Returns array of string arrays. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  const src = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

export function toCsv(rows, headers) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(',')];
  for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
  return lines.join('\r\n') + '\r\n';
}

const HEADER_ALIASES = {
  uuid: ['uuid', 'id', 'studentid', 'enrollment', 'enrollmentno', 'rollno', 'roll', 'uid', 'universityid', 'regno', 'registrationno'],
  name: ['name', 'studentname', 'fullname'],
  course: ['course', 'program', 'programme', 'degree'],
  year: ['year', 'sem', 'semester', 'batch'],
  specialization: ['specialization', 'specialisation', 'branch', 'stream', 'spec'],
  bus: ['bus', 'busnumber', 'busno', 'busid', 'route'],
  stop: ['stop', 'stopname', 'busstop', 'pickup', 'pickuppoint'],
  phone: ['phone', 'mobile', 'contact', 'phoneno'],
};

/** Map a header row to canonical keys. Returns { index: { uuid: 0, name: 1 ... } } */
export function mapHeaders(headerRow) {
  const idx = {};
  headerRow.forEach((h, i) => {
    const key = String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const [canon, aliases] of Object.entries(HEADER_ALIASES)) {
      if (idx[canon] == null && aliases.includes(key)) idx[canon] = i;
    }
  });
  return idx;
}
