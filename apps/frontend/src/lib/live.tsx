'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { WS_CLOSE, type LiveMessage, type LogLine } from '@cc/shared';
import { WS_URL } from './config';
import { useAuth } from './auth';

export type LiveStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'forbidden';

export interface LogBatch {
  service: string;
  lines: LogLine[];
  dropped: number;
}

export interface LogSubscriptionOptions {
  service: string;
  stream: 'all' | 'out' | 'err';
  backfill?: number;
  onBatch(batch: LogBatch): void;
  /** The connection (re)opened: the server sends the backfill again, so drop what you have. */
  onReset?(): void;
  onError?(code: string, message: string): void;
}

export interface ServerEvent {
  kind: string;
  ts: number;
  [k: string]: unknown;
}

interface LiveApi {
  status: LiveStatus;
  live: LiveMessage | null;
  lastMessageAt: number | null;
  /** True when connected but no snapshot has arrived recently (live pushes come every 2 s). */
  stale: boolean;
  /** Tails one service's log. Resubscribes by itself after a reconnect. Returns the unsubscribe function. */
  subscribeLogs(opts: LogSubscriptionOptions): () => void;
  /** Server events such as alert_opened / alert_resolved. */
  subscribeEvents(handler: (e: ServerEvent) => void): () => void;
}

const STALE_AFTER_MS = 7_000;
const Ctx = createContext<LiveApi | null>(null);

/**
 * One shared WebSocket per tab. Reconnects with exponential backoff and jitter,
 * and shows its own state honestly instead of freezing on the last value.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [status, setStatus] = useState<LiveStatus>('idle');
  const [live, setLive] = useState<LiveMessage | null>(null);
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const lastAtRef = useRef<number | null>(null);
  const refreshRef = useRef(auth.refresh);
  refreshRef.current = auth.refresh;
  const wsRef = useRef<WebSocket | null>(null);
  const logSubs = useRef(new Map<string, LogSubscriptionOptions>());
  const eventSubs = useRef(new Set<(e: ServerEvent) => void>());

  const sendSubscribe = (ws: WebSocket, o: LogSubscriptionOptions) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        channel: 'logs',
        service: o.service,
        stream: o.stream,
        backfill: o.backfill ?? 200,
      }),
    );
  };

  const subscribeLogs = useCallback((o: LogSubscriptionOptions) => {
    logSubs.current.set(o.service, o);
    const ws = wsRef.current;
    if (ws) sendSubscribe(ws, o);
    return () => {
      if (logSubs.current.get(o.service) !== o) return; // replaced by a newer subscription
      logSubs.current.delete(o.service);
      const cur = wsRef.current;
      if (cur && cur.readyState === WebSocket.OPEN) {
        cur.send(JSON.stringify({ type: 'unsubscribe', channel: 'logs', service: o.service }));
      }
    };
  }, []);

  const subscribeEvents = useCallback((h: (e: ServerEvent) => void) => {
    eventSubs.current.add(h);
    return () => {
      eventSubs.current.delete(h);
    };
  }, []);

  const enabled = auth.state.status === 'authed' && !auth.state.me.mustChangePassword;
  const userId = auth.state.status === 'authed' ? auth.state.me.user.id : null;

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      setLive(null);
      setLastMessageAt(null);
      lastAtRef.current = null;
      return;
    }
    let cancelled = false;
    let attempt = 0;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
      const sock = new WebSocket(WS_URL);
      ws = sock;
      sock.onopen = () => {
        attempt = 0;
        wsRef.current = sock;
        setStatus('open');
        sock.send(JSON.stringify({ type: 'subscribe', channel: 'live' }));
        for (const o of logSubs.current.values()) {
          o.onReset?.();
          sendSubscribe(sock, o);
        }
      };
      sock.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { type: string; [k: string]: unknown };
          if (msg.type === 'live') {
            const now = Date.now();
            lastAtRef.current = now;
            setLive(msg as unknown as LiveMessage);
            setLastMessageAt(now);
            setStale(false);
          } else if (msg.type === 'log_batch') {
            logSubs.current.get(String(msg.service))?.onBatch(msg as unknown as LogBatch);
          } else if (msg.type === 'error') {
            for (const o of logSubs.current.values()) o.onError?.(String(msg.code), String(msg.message ?? ''));
          } else if (msg.type === 'event') {
            for (const h of eventSubs.current) h(msg as unknown as ServerEvent);
          }
        } catch {
          // ignore malformed frames
        }
      };
      sock.onclose = (ev) => {
        if (wsRef.current === sock) wsRef.current = null;
        if (cancelled) return;
        if (ev.code === WS_CLOSE.ORIGIN_NOT_ALLOWED) {
          setStatus('forbidden'); // a configuration problem; retrying will not help
          return;
        }
        if (ev.code === WS_CLOSE.UNAUTHENTICATED) void refreshRef.current(); // session ended?
        setStatus('reconnecting');
        const base = Math.min(30_000, 1_000 * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(connect, base * (0.5 + Math.random() / 2));
      };
      sock.onerror = () => sock.close();
    };
    connect();

    const tick = setInterval(() => {
      const at = lastAtRef.current;
      setStale(at !== null && Date.now() - at > STALE_AFTER_MS);
    }, 1_000);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(tick);
      wsRef.current = null;
      ws?.close();
    };
  }, [enabled, userId]);

  const value = useMemo(
    () => ({ status, live, lastMessageAt, stale, subscribeLogs, subscribeEvents }),
    [status, live, lastMessageAt, stale, subscribeLogs, subscribeEvents],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive(): LiveApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLive must be used inside <LiveProvider>');
  return v;
}

/** True only when data is actually flowing right now. */
export function useIsFresh(): boolean {
  const { status, stale, live } = useLive();
  return status === 'open' && !stale && live !== null;
}
