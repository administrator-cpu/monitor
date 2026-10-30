'use client';

import type { MonitorRunsAs } from '@cc/shared';
import { HistoryPanel, IncidentTimeline, WindowsEvents } from '@/components/History';
import { PageHead, Shell } from '@/components/Shell';
import { UPlotChart } from '@/components/UPlotChart';
import { bytes, dateTime, duration, pct, rate, timeAgo } from '@/lib/format';
import { useIsFresh, useLive } from '@/lib/live';
import { useHostSeries } from '@/lib/useHostSeries';

const PCT = (v: number) => `${Math.round(v)}%`;

/** H9: production runs as a Windows service; PM2 or a hand start means the switch is not done. */
function runsAsLabel(r: MonitorRunsAs | undefined): string {
  if (!r) return '—';
  if (r.kind === 'service') return r.name ? `Windows service ${r.name}` : 'Windows service';
  if (r.kind === 'pm2') return r.name ? `PM2 process ${r.name}` : 'PM2';
  return 'Started by hand';
}

function ChartCard({
  title,
  now,
  children,
}: {
  title: string;
  now?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card" aria-label={title}>
      <div className="card-head">
        <h2>{title}</h2>
        {now && <span className="now">{now}</span>}
      </div>
      {children}
    </section>
  );
}

function Host() {
  const { live } = useLive();
  const fresh = useIsFresh();
  const s = useHostSeries();
  const host = live?.host ?? null;
  const collectors = live?.collectors ?? s.collectors ?? [];
  const m = s.monitor;

  return (
    <>
      <PageHead title="Host" />

      {s.error && (
        <div className="banner crit" role="alert">
          Could not load host history: {s.error.message}
        </div>
      )}

      <div className="grid two">
        <ChartCard title="CPU · last 30 min" now={fresh && host ? pct(host.cpuPct) : undefined}>
          <UPlotChart
            data={s.cpu}
            series={[{ label: 'CPU %', colorVar: '--series-1' }]}
            yRange={[0, 100]}
            format={PCT}
            ariaLabel="CPU usage over the last 30 minutes"
          />
        </ChartCard>
        <ChartCard
          title="Memory · last 30 min"
          now={
            fresh && host && host.memTotalBytes
              ? pct((host.memUsedBytes / host.memTotalBytes) * 100)
              : undefined
          }
        >
          <UPlotChart
            data={s.mem}
            series={[{ label: 'Memory %', colorVar: '--series-1' }]}
            yRange={[0, 100]}
            format={PCT}
            ariaLabel="Memory usage over the last 30 minutes"
          />
        </ChartCard>
        <ChartCard
          title="Network · last 30 min"
          now={fresh && host ? `↓ ${rate(host.netRxBps)}  ↑ ${rate(host.netTxBps)}` : undefined}
        >
          <UPlotChart
            data={s.net}
            series={[
              { label: 'Down', colorVar: '--series-1' },
              { label: 'Up', colorVar: '--series-2', fill: false },
            ]}
            format={rate}
            ariaLabel="Network throughput over the last 30 minutes"
          />
        </ChartCard>
        <section className="card" aria-label="Per-core CPU">
          <h2>Per-core CPU (live)</h2>
          {host && fresh ? (
            <div className="cores">
              {host.cpuPerCore.map((v, i) => (
                <div className="core" key={i} title={`Core ${i}: ${pct(v)}`}>
                  <div className="col">
                    <span style={{ height: `${Math.min(100, v)}%` }} />
                  </div>
                  <span className="num">{i}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">No live data.</div>
          )}
        </section>
      </div>

      <div className="grid two" style={{ marginTop: 14 }}>
        <section className="card" aria-label="Host details">
          <h2>Details</h2>
          {host ? (
            <dl className="kv num">
              <dt>Memory</dt>
              <dd>
                {bytes(host.memUsedBytes)} / {bytes(host.memTotalBytes)}
              </dd>
              <dt>Swap</dt>
              <dd>
                {host.swapTotalBytes
                  ? `${bytes(host.swapUsedBytes)} / ${bytes(host.swapTotalBytes)}`
                  : 'none'}
              </dd>
              <dt>Uptime</dt>
              <dd>{duration(host.uptimeS)}</dd>
              <dt>Reboot pending</dt>
              <dd>{host.pendingReboot ? 'yes' : 'no'}</dd>
              <dt>Last sample</dt>
              <dd>{dateTime(host.updatedAt)}</dd>
            </dl>
          ) : (
            <div className="empty">No data yet.</div>
          )}
        </section>

        <section className="card" aria-label="Monitor health">
          <h2>Monitor health</h2>
          {m ? (
            <dl className="kv num">
              <dt>Process CPU</dt>
              <dd>{pct(m.cpuPct)}</dd>
              <dt>Memory (RSS)</dt>
              <dd>{bytes(m.rssBytes, 0)}</dd>
              <dt>Heap used</dt>
              <dd>{bytes(m.heapUsedBytes, 0)}</dd>
              <dt>Event loop lag p95 / max</dt>
              <dd>
                {m.eventLoopLagP95Ms} / {m.eventLoopLagMaxMs} ms
              </dd>
              <dt>Browsers connected</dt>
              <dd>{m.wsClients}</dd>
              <dt>SQLite size</dt>
              <dd>{m.sqliteBytes == null ? '—' : bytes(m.sqliteBytes)}</dd>
              <dt>Monitor uptime</dt>
              <dd>{duration(m.uptimeS)}</dd>
              <dt>Runs as</dt>
              <dd data-testid="monitor-runs-as">{runsAsLabel(m.runsAs)}</dd>
              <dt>Deployed commit</dt>
              <dd data-testid="monitor-deployed-sha">
                {m.deployedSha ? <code title={m.deployedSha}>{m.deployedSha.slice(0, 7)}</code> : '—'}
              </dd>
            </dl>
          ) : (
            <div className="empty">Loading…</div>
          )}
        </section>
      </div>

      <section className="card" style={{ marginTop: 14 }} aria-label="Collectors">
        <h2>Collectors</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Collector</th>
                <th>Interval</th>
                <th>Last success</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {collectors.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td className="num">{c.intervalMs / 1000}s</td>
                  <td>{timeAgo(c.lastOkAt)}</td>
                  <td>
                    {c.stale ? (
                      <span className="tag warn">stale</span>
                    ) : c.lastError ? (
                      <span className="tag crit">error</span>
                    ) : (
                      <span className="tag ok">ok</span>
                    )}
                    {c.lastError && <span className="muted"> {c.lastError}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <HistoryPanel
        path="/history/host"
        heading="History"
        charts={[
          { title: 'CPU', keys: [{ key: 'cpuPct', label: 'CPU %', colorVar: '--series-1' }, { key: 'cpuMaxCorePct', label: 'Busiest core %', colorVar: '--series-2', fill: false }], format: PCT, yRange: [0, 100] },
          { title: 'Memory', keys: [{ key: 'memPct', label: 'Memory %', colorVar: '--series-1' }], format: PCT, yRange: [0, 100] },
          { title: 'Network', keys: [{ key: 'netRxBps', label: 'Received', colorVar: '--series-1' }, { key: 'netTxBps', label: 'Sent', colorVar: '--series-2', fill: false }], format: (v) => rate(v) },
        ]}
      >
        {(_r, range) => <IncidentTimeline from={range.from} to={range.to} />}
      </HistoryPanel>

      <WindowsEvents />
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Host />
    </Shell>
  );
}
