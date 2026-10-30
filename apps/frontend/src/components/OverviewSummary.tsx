'use client';

import Link from 'next/link';
import { Fragment, useEffect } from 'react';
import useSWR from 'swr';
import type { MonitorHealth, OverviewSummary as Summary, Severity } from '@cc/shared';
import { fetcher } from '@/lib/api';
import { bytes, duration, pct, timeAgo } from '@/lib/format';

const sevClass = (s: Severity) => (s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : '');

/** The monitor itself, shown first among the services (it left PM2 with H9). */
export function MonitorTile({ m, stale }: { m: MonitorHealth | undefined; stale: boolean }) {
  const runs = !m
    ? 'unknown'
    : m.runsAs.kind === 'service'
      ? 'Windows service'
      : m.runsAs.kind === 'pm2'
        ? 'PM2'
        : 'started by hand';
  return (
    <Link href="/host" className="svc" data-testid="svc-monitor">
      <div className="name">
        <span
          className={`dot ${stale || !m ? 'warn' : 'ok'}`}
          role="img"
          aria-label={stale || !m ? 'no live data' : 'online'}
        />
        Command Center (this monitor)
      </div>
      <div className="muted" style={{ fontSize: '0.82rem' }} data-testid="monitor-tile-runs">
        {stale ? 'stale' : `online · ${runs}`}
      </div>
      {m && !stale && (
        <div className="facts num">
          <span>CPU {pct(m.cpuPct)}</span>
          <span>{bytes(m.rssBytes, 0)}</span>
          <span>up {duration(m.uptimeS)}</span>
          <span>{m.deployedSha ? m.deployedSha.slice(0, 7) : 'no deploy commit'}</span>
        </div>
      )}
    </Link>
  );
}

function AlertsCard({ s }: { s: Summary['alerts'] }) {
  const total = s.critical + s.warning + s.info;
  return (
    <section className="card" aria-label="Alerts summary">
      <div className="card-head">
        <h2>Alerts</h2>
        <Link href="/alerts" className="muted">
          All alerts
        </Link>
      </div>
      {total === 0 ? (
        <div data-testid="alerts-none">
          <span className="dot ok" aria-hidden="true" /> No alerts firing.
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 8, marginBottom: 10 }} data-testid="alerts-counts">
            {s.critical > 0 && <span className="tag crit">{s.critical} critical</span>}
            {s.warning > 0 && <span className="tag warn">{s.warning} warning</span>}
            {s.info > 0 && <span className="tag">{s.info} info</span>}
          </div>
          <ul className="summary-list">
            {s.newest.map((i) => (
              <li key={i.id}>
                <span className={`tag ${sevClass(i.severity)}`}>{i.ruleName}</span>
                {i.serviceName && <span className="muted"> · {i.serviceName}</span>}
                <div className="muted small">
                  {i.summary} · {timeAgo(i.openedAt)}
                </div>
              </li>
            ))}
          </ul>
          {total > s.newest.length && (
            <div className="muted small">and {total - s.newest.length} more</div>
          )}
        </>
      )}
    </section>
  );
}

function BackupCertCard({ b, t }: { b: Summary['backup']; t: Summary['tls'] }) {
  const certClass = t.soonest
    ? t.soonest.daysLeft <= 3
      ? 'crit'
      : t.soonest.daysLeft <= 14
        ? 'warn'
        : 'ok'
    : '';
  return (
    <section className="card" aria-label="Backups and certificates">
      <div className="card-head">
        <h2>Backups and certificates</h2>
        <Link href="/nginx" className="muted">
          Certificates
        </Link>
      </div>
      <dl className="kv">
        <dt>Last backup</dt>
        <dd data-testid="backup-status">
          {!b.enabled ? (
            <span className="tag warn">off (BACKUP_DIR)</span>
          ) : b.lastRunAt === null ? (
            <span className="muted">none yet</span>
          ) : (
            <>
              <span className={`tag ${b.status === 'ok' ? 'ok' : 'crit'}`}>{b.status === 'ok' ? 'ok' : 'failed'}</span>{' '}
              {timeAgo(b.lastRunAt)}
            </>
          )}
        </dd>
        {b.file && (
          <>
            <dt>File</dt>
            <dd className="num">
              {b.file}
              {b.bytes !== null ? ` · ${bytes(b.bytes)}` : ''}
            </dd>
          </>
        )}
        {b.error && (
          <>
            <dt>Error</dt>
            <dd className="small">{b.error}</dd>
          </>
        )}
        <dt>Certificates</dt>
        <dd>
          {t.hosts === 0 ? (
            <span className="muted">none checked</span>
          ) : (
            <>
              {t.hosts} checked
              {t.errors > 0 && (
                <>
                  {' '}
                  <span className="tag warn">{t.errors} failed</span>
                </>
              )}
            </>
          )}
        </dd>
        {t.soonest && (
          <>
            <dt>Expires first</dt>
            <dd data-testid="cert-soonest">
              {t.soonest.host} <span className={`tag ${certClass}`}>in {t.soonest.daysLeft} days</span>
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

function GitEmailCard({ g, e }: { g: Summary['github']; e: Summary['email'] }) {
  return (
    <section className="card" aria-label="GitHub and email">
      <div className="card-head">
        <h2>GitHub and email</h2>
        <Link href="/email" className="muted">
          Email
        </Link>
      </div>
      <dl className="kv">
        <dt>GitHub</dt>
        <dd data-testid="github-status">
          {g.mapped === 0 ? (
            <span className="muted">no repositories set</span>
          ) : (
            <>
              {g.inSync} of {g.mapped} up to date
              {g.problems > 0 && (
                <>
                  {' '}
                  <span className="tag warn">{g.problems} not checked</span>
                </>
              )}
            </>
          )}
        </dd>
        {g.behind.map((b) => (
          <Fragment key={b.serviceId}>
            <dt>Behind</dt>
            <dd>
              <Link href={`/services/${b.serviceId}`}>{b.name}</Link> <span className="tag warn">{b.behindBy} behind</span>
            </dd>
          </Fragment>
        ))}
        {!g.tokenSet && g.mapped > 0 && (
          <>
            <dt />
            <dd className="muted small">GITHUB_TOKEN is not set</dd>
          </>
        )}
        <dt>Email, 24 h</dt>
        <dd data-testid="email-status">
          {!e.webhookConfigured ? (
            <span className="muted">Resend webhook not set up</span>
          ) : (
            <>
              <span className="num">
                {e.sent} sent · {e.delivered} delivered
              </span>
              {e.bounced + e.complained + e.failed > 0 && (
                <>
                  {' '}
                  <span className="tag crit">
                    {e.bounced} bounced · {e.complained} complaints · {e.failed} failed
                  </span>
                </>
              )}
            </>
          )}
        </dd>
        {e.webhookConfigured && (
          <>
            <dt>Last email event</dt>
            <dd>{timeAgo(e.lastEventAt)}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

/**
 * Alerts, backups, certificates, GitHub and email in one row; refreshed every 30 s, and at once
 * when the live feed's count of open alerts changes, so the card agrees with the banner.
 */
export function SummaryRow({ openIncidents }: { openIncidents: number | undefined }) {
  const { data, error, mutate } = useSWR<Summary>('/overview/summary', fetcher, { refreshInterval: 30_000 });
  useEffect(() => {
    if (openIncidents !== undefined) void mutate();
  }, [openIncidents, mutate]);
  if (error && !data) {
    return (
      <div className="banner warn" role="status" style={{ marginTop: 14 }}>
        Could not load the summary: {(error as Error).message}
      </div>
    );
  }
  if (!data) return null;
  return (
    <div className="grid summary" style={{ marginTop: 14 }} data-testid="summary-row">
      <AlertsCard s={data.alerts} />
      <BackupCertCard b={data.backup} t={data.tls} />
      <GitEmailCard g={data.github} e={data.email} />
    </div>
  );
}
