export function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export const rate = (bps: number | null | undefined): string =>
  bps == null || !Number.isFinite(bps) ? '—' : `${bytes(bps)}/s`;

export function pct(n: number | null | undefined, digits?: number): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(digits ?? (n < 10 ? 1 : 0))}%`;
}

export function duration(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return '—';
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function dateTime(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function timeAgo(ms: number | null | undefined, now: number = Date.now()): string {
  if (ms == null) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Colour band for a usage percentage. Disks use the alert defaults (85 / 95). */
export function usageLevel(p: number, warn = 85, crit = 95): 'ok' | 'warn' | 'crit' {
  return p >= crit ? 'crit' : p >= warn ? 'warn' : 'ok';
}

/** Plain-language reason the log volume cannot be used (codes come from the backend volume guard). */
export function volumeReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case 'missing':
      return 'the log folder is missing or its drive is not available';
    case 'same_volume':
      return 'the log folder is on the same drive as Windows, which is not allowed';
    case 'error':
      return 'the log drive could not be checked';
    default:
      return 'unknown reason';
  }
}
