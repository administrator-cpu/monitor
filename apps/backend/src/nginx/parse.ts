/** One parsed access-log line (the `monitor_json` format from the runbook, backend-schema.md section 4). */
export interface AccessRecord {
  ip: string;
  /** Lower-case host name without a port. */
  host: string;
  method: string;
  uri: string;
  status: number;
  bytes: number;
  /** Request time in seconds, null when absent. */
  rt: number | null;
  /** Upstream address, e.g. `127.0.0.1:3001` (last one if several). */
  up: string;
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && v.trim() !== '-') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Returns null for anything that is not a usable access record. A bad line is skipped, never fatal. */
export function parseAccessLine(line: string): AccessRecord | null {
  const t = line.trim();
  if (t.length === 0 || t[0] !== '{') return null;
  let o: unknown;
  try {
    o = JSON.parse(t);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const status = num(r.status);
  if (status === null || !Number.isInteger(status) || status < 100 || status > 599) return null;
  const bytes = num(r.bytes);
  const rt = num(r.rt);
  const upRaw = str(r.up, 200);
  const up = upRaw.split(',').pop()?.trim() ?? '';
  return {
    ip: str(r.ip, 64),
    host: str(r.host, 255).toLowerCase().replace(/:\d+$/, ''),
    method: str(r.method, 16),
    uri: str(r.uri, 2_048),
    status,
    bytes: bytes !== null && bytes >= 0 ? Math.round(bytes) : 0,
    rt: rt !== null && rt >= 0 ? rt : null,
    up: up === '-' ? '' : up,
  };
}

/** The path without its query string, for the top-paths list (query strings can carry tokens). */
export function pathOf(uri: string): string {
  const q = uri.indexOf('?');
  const p = (q === -1 ? uri : uri.slice(0, q)) || '/';
  return p.length > 200 ? `${p.slice(0, 200)}…` : p;
}

export interface MatchRule {
  serviceId: number;
  /** A host name (`api.example.com`, `*.example.com`) or an upstream address (`127.0.0.1:3001`). */
  match: string;
}

/**
 * Attributes a record to a service. Host names are compared case-insensitively without the port,
 * `*.` matches any sub-domain, and an upstream address matches `up` exactly. No match is service 0
 * (`_unattributed`). The first matching service in the list wins, exact before wildcard.
 */
export function matchService(rec: AccessRecord, rules: MatchRule[]): number {
  let wildcard: number | null = null;
  for (const r of rules) {
    const m = r.match.trim().toLowerCase();
    if (!m) continue;
    if (m.startsWith('*.')) {
      if (wildcard === null && rec.host.endsWith(m.slice(1)) && rec.host.length > m.length - 1) wildcard = r.serviceId;
      continue;
    }
    if (m === rec.host || (rec.up !== '' && m === rec.up.toLowerCase())) return r.serviceId;
    if (m.includes(':') && rec.host !== '' && m === `${rec.host}:${rec.up.split(':')[1] ?? ''}`) return r.serviceId;
  }
  return wildcard ?? 0;
}
