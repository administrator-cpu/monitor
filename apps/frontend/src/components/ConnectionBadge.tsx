'use client';

import { useEffect, useState } from 'react';
import { useLive } from '@/lib/live';

/** The single place that tells the viewer whether the numbers on screen are live. */
export function ConnectionBadge() {
  const { status, stale, lastMessageAt } = useLive();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!stale) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [stale]);

  let label: string;
  let level: 'ok' | 'warn' | 'crit' = 'warn';
  if (status === 'open' && !stale && lastMessageAt) {
    label = 'Live';
    level = 'ok';
  } else if (status === 'open' && stale) {
    const secs = lastMessageAt && now ? Math.round((now - lastMessageAt) / 1000) : null;
    label = secs ? `Stale · no data for ${secs}s` : 'Stale';
  } else if (status === 'forbidden') {
    label = 'Blocked · origin not allowed';
    level = 'crit';
  } else if (status === 'open') {
    label = 'Connected · waiting for data';
  } else if (status === 'connecting') {
    label = 'Connecting…';
  } else {
    label = 'Disconnected · retrying';
  }

  return (
    <span
      className="pill"
      role="status"
      aria-live="polite"
      data-testid="connection-badge"
      data-state={level === 'ok' ? 'live' : status === 'open' ? 'stale' : 'down'}
    >
      <span className={`dot ${level}`} aria-hidden="true" />
      {label}
    </span>
  );
}
