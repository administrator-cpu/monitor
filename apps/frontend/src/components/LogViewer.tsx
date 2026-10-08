'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LogLine } from '@cc/shared';
import { useLive } from '@/lib/live';

type StreamFilter = 'all' | 'out' | 'err';

/** Lines kept in the browser. The server keeps its own buffer; this only bounds this tab's memory. */
const KEEP = 2_000;
/** Lines drawn at once. */
const SHOW = 600;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, '');

const clock = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

const Row = memo(function Row({ l, showPm }: { l: LogLine; showPm: boolean }) {
  return (
    <div className={`log-line ${l.s === 'err' ? 'err' : ''}`}>
      <span className="log-ts">{clock(l.ts)}</span>
      {showPm && <span className="log-pm">#{l.pm}</span>}
      <span className="log-msg">
        {stripAnsi(l.msg).replace(/\n$/, '')}
        {l.cut ? <span className="log-cut"> … {l.cut} more characters not shown</span> : null}
      </span>
    </div>
  );
});

/**
 * Live tail of one service. The server sends the recent backlog first and then batches every
 * 250 ms. Pausing stops the display from moving (new lines wait in memory); a slow tab is told
 * how many lines were skipped rather than silently losing them.
 */
export function LogViewer({ service }: { service: string }) {
  const { subscribeLogs, status } = useLive();
  const [stream, setStream] = useState<StreamFilter>('all');
  const [filter, setFilter] = useState('');
  const [paused, setPaused] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [held, setHeld] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  const all = useRef<LogLine[]>([]);
  const shownLen = useRef(0);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  const publish = useCallback(() => {
    shownLen.current = all.current.length;
    setLines(all.current.slice());
    setHeld(0);
  }, []);

  useEffect(() => {
    all.current = [];
    shownLen.current = 0;
    setLines([]);
    setHeld(0);
    setDropped(0);
    setProblem(null);
    const off = subscribeLogs({
      service,
      stream,
      backfill: 300,
      onReset: () => {
        all.current = [];
        shownLen.current = 0;
        setLines([]);
        setHeld(0);
      },
      onBatch: (b) => {
        if (b.dropped > 0) setDropped((n) => n + b.dropped);
        // A batch already in flight for the previous stream choice can arrive after the switch.
        const fresh = stream === 'all' ? b.lines : b.lines.filter((l) => l.s === stream);
        if (fresh.length > 0) {
          const next = all.current.concat(fresh);
          all.current = next.length > KEEP ? next.slice(next.length - KEEP) : next;
        }
        if (pausedRef.current) setHeld(Math.min(KEEP, all.current.length - shownLen.current));
        else publish();
      },
      onError: (code, message) => setProblem(code === 'unknown_service' ? 'This service has no log stream.' : message),
    });
    return off;
  }, [service, stream, subscribeLogs, publish]);

  useEffect(() => {
    if (!paused) publish();
  }, [paused, publish]);

  useEffect(() => {
    const el = box.current;
    if (el && follow.current && !paused) el.scrollTop = el.scrollHeight;
  }, [lines, paused]);

  const needle = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    const f = needle ? lines.filter((l) => stripAnsi(l.msg).toLowerCase().includes(needle)) : lines;
    return f.length > SHOW ? f.slice(f.length - SHOW) : f;
  }, [lines, needle]);
  const multi = useMemo(() => new Set(lines.map((l) => l.pm)).size > 1, [lines]);

  const live = status === 'open';
  return (
    <section className="card" aria-label="Logs">
      <div className="card-head">
        <h2>Logs</h2>
        <span className="now" data-testid="log-state">
          {!live ? 'Reconnecting…' : paused ? `Paused${held ? ` · ${held} new` : ''}` : 'Live'}
        </span>
      </div>

      <div className="row log-tools">
        <select aria-label="Stream" value={stream} onChange={(e) => setStream(e.target.value as StreamFilter)} style={{ width: 'auto' }}>
          <option value="all">All output</option>
          <option value="out">stdout only</option>
          <option value="err">stderr only</option>
        </select>
        <input
          aria-label="Filter lines"
          placeholder="Filter lines in view…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ maxWidth: 260 }}
        />
        <button className="btn small" onClick={() => setPaused((p) => !p)}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button className="btn small" onClick={() => { all.current = []; shownLen.current = 0; setLines([]); setHeld(0); }}>
          Clear view
        </button>
      </div>

      {problem && <div className="banner warn" role="alert">{problem}</div>}
      {dropped > 0 && (
        <div className="banner warn" role="status">
          {dropped} lines were skipped because this browser could not keep up. They are still in the log files.
        </div>
      )}
      {!live && (
        <div className="banner warn" role="status">
          Not connected. The tail resumes by itself when the connection returns.
        </div>
      )}

      <div
        ref={box}
        className="log-box"
        data-testid="log-box"
        role="log"
        aria-live="off"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {visible.length === 0 ? (
          <div className="muted log-empty">{needle ? 'No lines match the filter.' : 'No log lines yet.'}</div>
        ) : (
          visible.map((l, i) => <Row key={`${l.ts}-${i}`} l={l} showPm={multi} />)
        )}
      </div>
      <div className="muted" style={{ marginTop: 6, fontSize: '0.8rem' }}>
        Showing the last {visible.length} of {lines.length} buffered lines. Stored files cover the full retention period.
      </div>
    </section>
  );
}
