'use client';

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import {
  LOCAL_HOST_ID,
  capRanges,
  spanLabel,
  type LogSearchRequest,
  type LogSearchResponse,
  type RangeLimitsResponse,
  type RangeOption,
  type ServicesResponse,
} from '@cc/shared';
import { PageHead, Shell } from '@/components/Shell';
import { api, ApiError, errorMessage, fetcher } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useLive } from '@/lib/live';

const WINDOWS: readonly RangeOption[] = [
  { id: '15m', label: 'Last 15 minutes', ms: 15 * 60_000 },
  { id: '1h', label: 'Last hour', ms: 3_600_000 },
  { id: '6h', label: 'Last 6 hours', ms: 6 * 3_600_000 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 3_600_000 },
];

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function Search() {
  // Every host's services: container logs from agent hosts are searched next to this server's (M3).
  const { data: svcs } = useSWR<ServicesResponse>('/services?archived=1&host=all', fetcher);
  const { live } = useLive();
  // Log files older than `logs.retention_hours` are deleted, so no window reaches further back.
  const { data: limits } = useSWR<RangeLimitsResponse>('/limits', fetcher, { revalidateOnFocus: false });
  const windows = useMemo(() => capRanges(WINDOWS, limits?.logSearchMaxMs, (ms) => `Last ${spanLabel(ms)}`), [limits?.logSearchMaxMs]);
  const [picked, setPicked] = useState<string[]>([]);
  const [winId, setWin] = useState('1h');
  // A choice the limit no longer allows falls back to the longest one allowed.
  const win = windows.find((w) => w.id === winId) ?? windows[windows.length - 1]!;
  const [stream, setStream] = useState<LogSearchRequest['stream']>('all');
  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [context, setContext] = useState(0);
  const [order, setOrder] = useState<'desc' | 'asc'>('desc');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LogSearchResponse | null>(null);

  const hostName = (id: number) => live?.hosts?.find((h) => h.id === id)?.name ?? `host ${id}`;
  const options = [
    // A container whose shipping is off keeps what was stored before, so it stays searchable.
    ...(svcs?.services ?? []).map((s) => ({ value: s.logKey, label: s.hostId === LOCAL_HOST_ID ? s.name : `${s.name} · ${hostName(s.hostId)}` })),
    { value: '_nginx', label: 'Nginx (access and error)' },
    { value: '_monitor', label: "This monitor's own log" },
  ];
  const labels = new Map(options.map((o) => [o.value, o.label]));
  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (picked.length === 0) {
      setError('Choose at least one service to search.');
      return;
    }
    setBusy(true);
    const to = Date.now();
    const from = to - win.ms;
    try {
      const r = await api<LogSearchResponse>('/logs/search', {
        method: 'POST',
        body: { services: picked, from, to, stream, query, regex, caseSensitive, context, order },
      });
      setResult(r);
    } catch (err) {
      setResult(null);
      setError(err instanceof ApiError ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead title="Log search" />
      <form className="card" onSubmit={submit} aria-label="Search logs" data-testid="search-form">
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sub">Services</legend>
          <div className="chips">
            {options.map((o) => (
              <label key={o.value} className="chip">
                <input type="checkbox" checked={picked.includes(o.value)} onChange={() => toggle(o.value)} /> {o.label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="form-row" style={{ marginTop: 12 }}>
          <label>
            Time
            <select value={win.id} onChange={(e) => setWin(e.target.value)}>
              {windows.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>
          </label>
          <label>
            Stream
            <select value={stream} onChange={(e) => setStream(e.target.value as typeof stream)}>
              <option value="all">All</option><option value="out">Output</option><option value="err">Errors</option>
              <option value="access">Nginx access</option><option value="error">Nginx error</option>
            </select>
          </label>
          <label>
            Context lines
            <select value={context} onChange={(e) => setContext(Number(e.target.value))}>
              {[0, 1, 2, 3, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label>
            Order
            <select value={order} onChange={(e) => setOrder(e.target.value as typeof order)}>
              <option value="desc">Newest first</option><option value="asc">Oldest first</option>
            </select>
          </label>
        </div>
        <div className="form-row" style={{ marginTop: 12 }}>
          <label style={{ flex: 1, minWidth: 220 }}>
            Text to find
            <input type="text" value={query} maxLength={200} onChange={(e) => setQuery(e.target.value)} placeholder="leave empty to list every line" data-testid="search-query" />
          </label>
          <label className="inline"><input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Regular expression</label>
          <label className="inline"><input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> Match case</label>
          <button type="submit" className="btn primary" disabled={busy} data-testid="search-go">{busy ? 'Searching…' : 'Search'}</button>
        </div>
        <p className="sub" style={{ marginTop: 10 }}>
          Logs are shown exactly as written and can contain emails and tokens. Each search is recorded in the audit log with
          its filter, not its results.
        </p>
      </form>

      {error && <div className="banner crit" role="alert" style={{ marginTop: 14 }}>{error}</div>}
      {result && (
        <section className="card" style={{ marginTop: 14 }} aria-label="Search results" data-testid="search-results">
          <div className="card-head">
            <h2>{result.matched} match{result.matched === 1 ? '' : 'es'}</h2>
            <span className="now num">{result.filesScanned} files · {result.linesScanned.toLocaleString()} lines · {result.tookMs} ms</span>
          </div>
          {result.truncated && (
            <div className="banner warn" role="status">There are more matches than can be shown. Narrow the time range or the text.</div>
          )}
          {result.timedOut && (
            <div className="banner warn" role="status">The search hit its 30 second limit, so only part of the range was searched.</div>
          )}
          {result.lines.length === 0 ? (
            <div className="empty">Nothing matched.</div>
          ) : (
            <div className="log-box" role="log" aria-label="Matching log lines" style={{ maxHeight: 560 }}>
              {result.lines.map((l, i) => (
                <div key={i} className={`log-line ${l.s === 'err' || l.s === 'error' ? 'err' : ''} ${l.ctx ? 'ctx' : ''}`}>
                  <span className="log-ts">{dateTime(l.ts)}</span>
                  <span className="log-pm">{labels.get(l.svc) ?? l.svc}{l.pm >= 0 ? `#${l.pm}` : ''}</span>
                  <span className="log-msg">{l.msg.replace(ANSI, '').replace(/\n$/, '')}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Search />
    </Shell>
  );
}
