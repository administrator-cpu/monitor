import type { Db } from '../db';
import type { LogPipeline } from '../logs/pipeline';
import type { ServicesRepo } from '../pm2/services';
import type { CollectorDef } from '../scheduler';
import type { StateStore, TlsCertRow } from '../state';
import { NginxAggregator } from './aggregate';
import { matchService, parseAccessLine, type MatchRule } from './parse';
import { fetchStub, rateFromCounters } from './stub';
import { checkCert, type CertInfo } from './tls';
import { LogTailer } from './tailer';

/** `stub_status` every 5 s. A failure is recorded as data (the alert rule decides), not thrown. */
export function nginxStatusCollector(d: {
  url: string;
  state: StateStore;
  now?: () => number;
  fetch?: typeof fetch;
}): CollectorDef {
  const now = d.now ?? Date.now;
  let prev: { at: number; requests: number } | null = null;
  return {
    name: 'nginxstatus',
    intervalMs: 5_000,
    timeoutMs: 5_000,
    async run() {
      const at = now();
      try {
        const s = await fetchStub(d.url, 3_000, d.fetch);
        const cur = { at, requests: s.requests };
        const reqPerS = rateFromCounters(prev, cur);
        prev = cur;
        d.state.setNginxStatus(at, { ok: true, sample: s, reqPerS });
      } catch (e) {
        prev = null;
        d.state.setNginxStatus(at, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}

export interface NginxLogDeps {
  accessLog: string;
  errorLog?: string;
  state: StateStore;
  services: ServicesRepo;
  pipeline: LogPipeline;
  now?: () => number;
  warn?: (o: Record<string, unknown>, m: string) => void;
  /** Tests start from the beginning of an existing file. */
  startAtEnd?: boolean;
}

export interface NginxLogCollector extends CollectorDef {
  aggregator: NginxAggregator;
  close(): Promise<void>;
}

/**
 * Reads the Nginx access log (every second), attributes each line to a service, feeds the 10 s
 * windows and the log pipeline (`_nginx`, so the raw lines are searchable for 24 hours). A line
 * that cannot be parsed is stored as text, counted, and otherwise ignored.
 */
export function nginxLogCollector(d: NginxLogDeps): NginxLogCollector {
  const now = d.now ?? Date.now;
  const access = new LogTailer(d.accessLog, { startAtEnd: d.startAtEnd ?? true });
  const errors = d.errorLog ? new LogTailer(d.errorLog, { startAtEnd: d.startAtEnd ?? true }) : null;
  const aggregator = new NginxAggregator();

  const rules = (): MatchRule[] =>
    d.services
      .list(false)
      .filter((s) => s.nginx_match)
      .map((s) => ({ serviceId: s.id, match: s.nginx_match as string }));

  return {
    name: 'nginxlog',
    intervalMs: 1_000,
    timeoutMs: 8_000,
    aggregator,
    async close() {
      await access.close();
      await errors?.close();
    },
    async run() {
      const at = now();
      const r = await access.poll();
      if (r.rotated) d.warn?.({ file: d.accessLog }, 'nginx access log was rotated');
      if (r.truncated) d.warn?.({ file: d.accessLog }, 'nginx access log was truncated');
      if (r.oversize > 0) aggregator.malformed(r.oversize);

      if (r.lines.length > 0) {
        const rs = rules();
        for (const line of r.lines) {
          d.pipeline.ingest('_nginx', -1, 'access', line, at);
          const rec = parseAccessLine(line);
          if (!rec) {
            aggregator.malformed();
            continue;
          }
          aggregator.add(rec, matchService(rec, rs), at);
        }
      }
      if (errors) {
        const e = await errors.poll();
        for (const line of e.lines) d.pipeline.ingest('_nginx', -1, 'error', line, at);
      }

      d.state.addNginxWindows(aggregator.advance(at));
      d.state.setNginxLog({
        at,
        malformedLines: aggregator.malformedLines,
        linesTotal: aggregator.linesTotal,
        lastLineAt: aggregator.lastLineAt,
      });

      if (!access.isOpen) throw new Error(`access log not found: ${d.accessLog}`);
    },
  };
}

/** Hosts to check: the configured list plus the https host of every active service's public URL. */
export function tlsHostsFor(configured: string[], services: ServicesRepo): string[] {
  const out = new Set(configured);
  for (const s of services.list(false)) {
    if (!s.public_url) continue;
    try {
      const u = new URL(s.public_url);
      if (u.protocol === 'https:') out.add(u.port ? `${u.hostname}:${u.port}` : u.hostname);
    } catch {
      // an invalid URL is simply not checked
    }
  }
  return [...out].sort();
}

/** Certificate expiry every 6 hours; results are stored so the page survives a restart. */
export function tlsCollector(d: {
  db: Db;
  state: StateStore;
  hosts: () => string[];
  now?: () => number;
  check?: (host: string) => Promise<CertInfo>;
}): CollectorDef {
  const now = d.now ?? Date.now;
  const check = d.check ?? ((h: string) => checkCert(h));
  const load = (): TlsCertRow[] =>
    (d.db.prepare('SELECT host, not_after, issuer, checked_at, last_error FROM tls_certs ORDER BY host').all() as {
      host: string;
      not_after: number | null;
      issuer: string | null;
      checked_at: number;
      last_error: string | null;
    }[]).map((r) => ({ host: r.host, notAfter: r.not_after, issuer: r.issuer, checkedAt: r.checked_at, lastError: r.last_error }));

  // Whatever was stored before a restart is shown immediately.
  d.state.setTlsCerts(load());

  return {
    name: 'tls',
    intervalMs: 6 * 3_600_000,
    timeoutMs: 180_000,
    async run() {
      const hosts = d.hosts();
      const upsert = d.db.prepare(
        `INSERT INTO tls_certs (host, not_after, issuer, checked_at, last_error) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(host) DO UPDATE SET not_after = COALESCE(excluded.not_after, tls_certs.not_after),
           issuer = COALESCE(excluded.issuer, tls_certs.issuer), checked_at = excluded.checked_at,
           last_error = excluded.last_error`,
      );
      for (const h of hosts) {
        const at = now();
        try {
          const c = await check(h);
          upsert.run(h, c.notAfter, c.issuer, at, null);
        } catch (e) {
          upsert.run(h, null, null, at, (e instanceof Error ? e.message : String(e)).slice(0, 300));
        }
      }
      if (hosts.length > 0) {
        d.db
          .prepare(`DELETE FROM tls_certs WHERE host NOT IN (${hosts.map(() => '?').join(',')})`)
          .run(...hosts);
      } else {
        d.db.prepare('DELETE FROM tls_certs').run();
      }
      d.state.setTlsCerts(load());
    },
  };
}
