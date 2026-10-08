'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import type { AlignedData } from 'uplot';
import type { HistoryResponse, IncidentDto, WindowsEventsResponse } from '@cc/shared';
import { UPlotChart } from '@/components/UPlotChart';
import { fetcher } from '@/lib/api';
import { dateTime, duration } from '@/lib/format';

export const RANGES = [
  { id: '1h', label: '1 hour', ms: 3_600_000 },
  { id: '6h', label: '6 hours', ms: 6 * 3_600_000 },
  { id: '24h', label: '24 hours', ms: 24 * 3_600_000 },
  { id: '3d', label: '3 days', ms: 3 * 86_400_000 },
  { id: '7d', label: '7 days', ms: 7 * 86_400_000 },
] as const;
export type RangeId = (typeof RANGES)[number]['id'];

export function RangePicker({ value, onChange }: { value: RangeId; onChange: (v: RangeId) => void }) {
  return (
    <div className="range-picker" role="group" aria-label="Time range">
      {RANGES.map((r) => (
        <button
          key={r.id}
          type="button"
          className={`btn small ${value === r.id ? 'primary' : ''}`}
          aria-pressed={value === r.id}
          onClick={() => onChange(r.id)}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/** A range that ends "now" is recomputed on each refresh; `to` is rounded so SWR keys stay stable for a minute. */
function useRange(id: RangeId): { from: number; to: number } {
  const [tick, setTick] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const t = setInterval(() => setTick(Math.floor(Date.now() / 60_000)), 60_000);
    return () => clearInterval(t);
  }, []);
  const ms = RANGES.find((r) => r.id === id)!.ms;
  return useMemo(() => ({ from: tick * 60_000 - ms, to: tick * 60_000 + 60_000 }), [tick, ms]);
}

export interface ChartSpec {
  title: string;
  keys: { key: string; label: string; colorVar: string; fill?: boolean }[];
  format?: (v: number) => string;
  yRange?: [number, number];
}

function HistoryChart({ data, spec }: { data: HistoryResponse; spec: ChartSpec }) {
  const aligned = useMemo<AlignedData>(
    () => [data.ts, ...spec.keys.map((k) => data.series[k.key] ?? data.ts.map(() => null))] as AlignedData,
    [data, spec],
  );
  const empty = spec.keys.every((k) => (data.series[k.key] ?? []).every((v) => v === null));
  return (
    <section className="card" aria-label={spec.title}>
      <div className="card-head"><h2>{spec.title}</h2></div>
      {empty ? (
        <div className="empty">No data recorded in this range.</div>
      ) : (
        <UPlotChart
          data={aligned}
          series={spec.keys.map((k) => ({ label: k.label, colorVar: k.colorVar, fill: k.fill }))}
          format={spec.format}
          yRange={spec.yRange}
          ariaLabel={`${spec.title}, ${data.range.stepS} second points`}
        />
      )}
    </section>
  );
}

/** Range picker plus a set of charts for one history endpoint. */
export function HistoryPanel({ path, charts, heading = 'History', children }: { path: string; charts: ChartSpec[]; heading?: string; children?: (r: HistoryResponse, range: { from: number; to: number }) => React.ReactNode }) {
  const [rangeId, setRangeId] = useState<RangeId>('24h');
  const range = useRange(rangeId);
  const { data, error } = useSWR<HistoryResponse>(`${path}?from=${range.from}&to=${range.to}`, fetcher, {
    refreshInterval: 60_000,
    keepPreviousData: true,
  });
  return (
    <section style={{ marginTop: 22 }} aria-label={heading} data-testid="history-panel">
      <div className="card-head" style={{ marginBottom: 10 }}>
        <h2>{heading}</h2>
        <RangePicker value={rangeId} onChange={setRangeId} />
      </div>
      {error && <div className="banner crit" role="alert">Could not load history: {error.message}</div>}
      {data && (
        <>
          <p className="sub" data-testid="history-step">
            One point per {data.range.stepS >= 60 ? `${Math.round(data.range.stepS / 60)} min` : `${data.range.stepS} s`}
            {data.range.boundary ? `. Before ${dateTime(data.range.boundary)} the stored points are one-minute averages (peaks are kept).` : '.'}
          </p>
          <div className="grid two">
            {charts.map((c) => <HistoryChart key={c.title} data={data} spec={c} />)}
          </div>
          {children?.(data, range)}
        </>
      )}
    </section>
  );
}

/** Alerts that were open at some point in the range, newest first. */
export function IncidentTimeline({ from, to, serviceId }: { from: number; to: number; serviceId?: number }) {
  const q = `/alerts/incidents?from=${from}&to=${to}&limit=50${serviceId !== undefined ? `&serviceId=${serviceId}` : ''}`;
  const { data } = useSWR<{ incidents: IncidentDto[] }>(q, fetcher, { refreshInterval: 60_000 });
  return (
    <section className="card" style={{ marginTop: 14 }} aria-label="Alerts in this range" data-testid="incident-timeline">
      <div className="card-head">
        <h2>Alerts in this range</h2>
        <Link href="/alerts" className="muted">All alerts</Link>
      </div>
      {!data || data.incidents.length === 0 ? (
        <div className="empty">No alerts were open in this range.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Opened</th><th>Lasted</th><th>Alert</th><th>What happened</th></tr></thead>
            <tbody>
              {data.incidents.map((i) => (
                <tr key={i.id}>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>{dateTime(i.openedAt)}</td>
                  <td className="num">{i.resolvedAt ? duration(Math.round((i.resolvedAt - i.openedAt) / 1000)) : <span className="tag crit">still open</span>}</td>
                  <td><span className={`tag ${i.severity === 'critical' ? 'crit' : i.severity === 'warning' ? 'warn' : ''}`}>{i.ruleName}</span>{i.serviceName ? <span className="muted"> · {i.serviceName}</span> : null}</td>
                  <td>{i.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function WindowsEvents() {
  const [level, setLevel] = useState<'all' | 'critical' | 'error' | 'warning'>('all');
  const { data } = useSWR<WindowsEventsResponse>(`/events/windows?limit=30${level === 'all' ? '' : `&level=${level}`}`, fetcher, { refreshInterval: 60_000 });
  return (
    <section className="card" style={{ marginTop: 14 }} aria-label="Windows events" data-testid="windows-events">
      <div className="card-head">
        <h2>Windows events</h2>
        <select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>
          <option value="all">All levels</option>
          <option value="critical">Critical</option>
          <option value="error">Error</option>
          <option value="warning">Warning</option>
        </select>
      </div>
      {data && !data.collecting && (
        <div className="banner warn" role="status">The Windows Event Log is read on a Windows host only; nothing is being collected here.</div>
      )}
      {!data || data.events.length === 0 ? (
        <div className="empty">No events recorded.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Level</th><th>Log</th><th>Source</th><th>Id</th><th>Message</th></tr></thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id}>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>{dateTime(e.ts)}</td>
                  <td><span className={`tag ${e.level === 'warning' ? 'warn' : 'crit'}`}>{e.level}</span></td>
                  <td>{e.logName}</td>
                  <td>{e.provider ?? '—'}</td>
                  <td className="num">{e.eventId ?? '—'}</td>
                  <td style={{ maxWidth: 420, wordBreak: 'break-word' }}>{(e.message ?? '').slice(0, 300)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
