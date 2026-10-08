'use client';

import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import type { ServicesResponse } from '@cc/shared';
import { processLabel, StatusDot } from '@/components/ServiceStatus';
import { PageHead, Shell } from '@/components/Shell';
import { bytes, duration, pct, timeAgo } from '@/lib/format';
import { fetcher } from '@/lib/api';
import { useIsFresh, useLive } from '@/lib/live';

function Services() {
  const [archived, setArchived] = useState(false);
  const { data, error } = useSWR<ServicesResponse>(`/services${archived ? '?archived=1' : ''}`, fetcher, {
    refreshInterval: 10_000,
  });
  const { live } = useLive();
  const fresh = useIsFresh();
  // The live message is newer than the REST response; prefer it for the process numbers.
  const liveBy = new Map((live?.services ?? []).map((s) => [s.process.serviceId, s.process]));

  return (
    <>
      <PageHead title="Services" />
      {error && (
        <div className="banner crit" role="alert">
          Could not load services: {error.message}
        </div>
      )}
      <section className="card" aria-label="Services">
        <div className="row" style={{ marginBottom: 10 }}>
          <label style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
              style={{ width: 'auto' }}
            />
            Show archived
          </label>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Status</th>
                <th>CPU</th>
                <th>Memory</th>
                <th>Restarts</th>
                <th>Uptime</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {(data?.services ?? []).map((s) => {
                const p = fresh ? (liveBy.get(s.id) ?? s.process) : s.process;
                return (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/services/${s.id}`}>{s.name}</Link>
                      {s.name !== s.pm2Name && <span className="muted"> ({s.pm2Name})</span>}
                      {s.isArchived && <span className="tag" style={{ marginLeft: 8 }}>archived</span>}
                      {!s.isArchived && s.stale && <span className="tag warn" style={{ marginLeft: 8 }}>not seen lately</span>}
                    </td>
                    <td>
                      <StatusDot p={p} /> {processLabel(p)}
                    </td>
                    <td className="num">{p && p.instances > 0 ? pct(p.cpuPct) : '—'}</td>
                    <td className="num">{p && p.instances > 0 ? bytes(p.memBytes, 0) : '—'}</td>
                    <td className="num">{p ? p.restarts : '—'}</td>
                    <td className="num">{p && p.instances > 0 ? duration(p.uptimeS) : '—'}</td>
                    <td>{timeAgo(s.lastSeenAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data && data.services.length === 0 && (
          <div className="empty">No services yet. PM2 processes appear here automatically.</div>
        )}
      </section>
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Services />
    </Shell>
  );
}
