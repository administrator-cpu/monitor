'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import useSWR from 'swr';
import type { ServicesResponse } from '@cc/shared';
import { GitBadgeTag } from '@/components/GitCard';
import { HostSwitcher, useHostId } from '@/components/HostSwitcher';
import { hasFigures, processLabel, StatusDot, uptimeText } from '@/components/ServiceStatus';
import { PageHead, Shell } from '@/components/Shell';
import { bytes, pct, timeAgo } from '@/lib/format';
import { fetcher } from '@/lib/api';
import { useIsFresh, useLive } from '@/lib/live';

function Services() {
  const hostId = useHostId();
  const [archived, setArchived] = useState(false);
  const query = [hostId === 1 ? null : `host=${hostId}`, archived ? 'archived=1' : null].filter(Boolean).join('&');
  const { data, error } = useSWR<ServicesResponse>(`/services${query ? `?${query}` : ''}`, fetcher, {
    refreshInterval: 10_000,
  });
  const { live } = useLive();
  const fresh = useIsFresh();
  // The live message is newer than the REST response; prefer it for the process numbers. It carries
  // this server's services only; an agent host's come from the REST response (one report per 10 s).
  const liveBy = new Map(hostId === 1 ? (live?.services ?? []).map((s) => [s.process.serviceId, s.process]) : []);
  const hostName = hostId === 1 ? null : (live?.hosts?.find((h) => h.id === hostId)?.name ?? `Host ${hostId}`);

  return (
    <>
      <PageHead title={hostName ? `Services · ${hostName}` : 'Services'}>
        <HostSwitcher hostId={hostId} />
      </PageHead>
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
                      {s.kind === 'container'
                        ? <span className="muted"> ({s.sourceKey})</span>
                        : s.name !== s.pm2Name && <span className="muted"> ({s.pm2Name})</span>}
                      {s.isArchived && <span className="tag" style={{ marginLeft: 8 }}>archived</span>}
                      {s.git && <span style={{ marginLeft: 8 }}><GitBadgeTag git={s.git} /></span>}
                      {!s.isArchived && s.stale && <span className="tag warn" style={{ marginLeft: 8 }}>not seen lately</span>}
                    </td>
                    <td>
                      <StatusDot p={p} /> {processLabel(p)}
                      {p?.health === 'unhealthy' && <span className="tag crit" style={{ marginLeft: 8 }}>unhealthy</span>}
                    </td>
                    <td className="num">{hasFigures(p) ? pct(p.cpuPct) : '—'}</td>
                    <td className="num">{hasFigures(p) ? bytes(p.memBytes, 0) : '—'}</td>
                    <td className="num">{p ? p.restarts : '—'}</td>
                    <td className="num" title={p?.uptimeApprox ? 'Started before the agent was watching; Docker only gives this to the unit.' : undefined}>
                      {uptimeText(p)}
                    </td>
                    <td>{timeAgo(s.lastSeenAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data && data.services.length === 0 && (
          <div className="empty">
            {hostId === 1
              ? 'No services yet. PM2 processes appear here automatically.'
              : 'No services yet. The containers of the watched compose projects appear here with the agent’s first report.'}
          </div>
        )}
      </section>
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      {/* useSearchParams (the host switcher) needs a boundary for the static build. */}
      <Suspense>
        <Services />
      </Suspense>
    </Shell>
  );
}
