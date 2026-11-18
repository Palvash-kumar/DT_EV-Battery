export function hoursToHm(hours) {
  if (hours === null || hours === undefined || Number.isNaN(hours)) return '–';
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

export function num(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '–';
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function dateTime(value) {
  if (!value) return '–';
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function timeOnly(value) {
  if (!value) return '–';
  return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ago(value, now = Date.now()) {
  if (!value) return 'never';
  const s = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const shortId = (id) => (id ? id.slice(0, 8) : '–');
