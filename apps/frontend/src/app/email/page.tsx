'use client';

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import type { AlignedData } from 'uplot';
import type { EmailSummaryResponse } from '@cc/shared';
import { PageHead, Shell } from '@/components/Shell';
import { UPlotChart } from '@/components/UPlotChart';
import { fetcher } from '@/lib/api';
import { timeAgo } from '@/lib/format';

const RANGES = [
  { hours: 24, label: 'Last 24 hours' },
  { hours: 168, label: 'Last 7 days' },
  { hours: 720, label: 'Last 30 days' },
];

function Email() {
  const [hours, setHours] = useState(24);
  const { data, error } = useSWR<EmailSummaryResponse>(`/email/summary?hours=${hours}`, fetcher, { refreshInterval: 30_000 });
  const chart = useMemo<AlignedData>(
    () => [(data?.hourly ?? []).map((h) => h.ts / 1000), (data?.hourly ?? []).map((h) => h.delivered), (data?.hourly ?? []).map((h) => h.bad)],
    [data],
  );
  const total = (k: 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed') => (data?.rows ?? []).reduce((a, r) => a + r[k], 0);

  return (
    <>
      <PageHead title="Email delivery" />
      {error && <div className="banner crit" role="alert">Could not load email data: {error.message}</div>}
      {data && !data.configured && (
        <div className="banner warn" role="status">
          Not connected to Resend yet. Set <code>RESEND_WEBHOOK_SECRET</code> in the server .env, restart the monitor, and add the webhook
          in the Resend dashboard (see the runbook). Only counts are stored, never message text or addresses.
        </div>
      )}
      {data?.configured && data.lastReceivedAt === null && (
        <div className="banner" role="status">Waiting for the first event from Resend. Send a test email to see it here.</div>
      )}
      {data && data.badLastHour > 0 && (
        <div className="banner warn" role="status">{data.badLastHour} email{data.badLastHour === 1 ? '' : 's'} bounced or drew a complaint in the last hour.</div>
      )}

      <div className="row" style={{ marginBottom: 12 }}>
        <label htmlFor="email-range" className="muted">Period</label>
        <select id="email-range" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          {RANGES.map((r) => <option key={r.hours} value={r.hours}>{r.label}</option>)}
        </select>
        {data?.lastReceivedAt != null && <span className="muted">Last event {timeAgo(data.lastReceivedAt)}</span>}
      </div>

      <div className="grid">
        <section className="card" aria-label="Totals">
          <h2>Totals</h2>
          <dl className="kv">
            <dt>Sent</dt><dd className="num">{total('sent')}</dd>
            <dt>Delivered</dt><dd className="num">{total('delivered')}</dd>
            <dt>Bounced</dt><dd className="num">{total('bounced')}</dd>
            <dt>Complaints</dt><dd className="num">{total('complained')}</dd>
            <dt>Failed</dt><dd className="num">{total('failed')}</dd>
          </dl>
        </section>
        <section className="card" aria-label="Delivered and bad per hour">
          <div className="card-head"><h2>Per hour</h2></div>
          <UPlotChart
            data={chart}
            series={[{ label: 'delivered', colorVar: '--series-1' }, { label: 'bounced or complained', colorVar: '--series-2', fill: false }]}
            ariaLabel="Delivered, and bounced or complained emails per hour"
          />
        </section>
      </div>

      <section className="card" aria-label="By sender domain" style={{ marginTop: 14 }}>
        <h2>By sender domain</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Domain</th><th>Sent</th><th>Delivered</th><th>Delayed</th><th>Bounced</th><th>Complaints</th><th>Failed</th><th>Suppressed</th></tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).map((r) => (
                <tr key={r.domain}>
                  <td>{r.domain}</td>
                  <td className="num">{r.sent}</td>
                  <td className="num">{r.delivered}</td>
                  <td className="num">{r.delayed}</td>
                  <td className="num">{r.bounced > 0 ? <span className="tag warn">{r.bounced}</span> : 0}</td>
                  <td className="num">{r.complained > 0 ? <span className="tag crit">{r.complained}</span> : 0}</td>
                  <td className="num">{r.failed}</td>
                  <td className="num">{r.suppressed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && data.rows.length === 0 && <div className="empty">No events in this period.</div>}
      </section>
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Email />
    </Shell>
  );
}
