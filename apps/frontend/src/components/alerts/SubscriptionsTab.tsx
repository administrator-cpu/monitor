'use client';

import { useState } from 'react';
import useSWR from 'swr';
import type { AlertCategory } from '@cc/shared';
import { api, errorMessage, fetcher } from '@/lib/api';

const CATS: [AlertCategory, string][] = [
  ['host', 'Host: disk, CPU, memory, reboot'],
  ['pm2', 'Services: down, crash loop, memory'],
  ['nginx', 'Nginx (later phase)'],
  ['mongo', 'MongoDB (later phase)'],
  ['app', 'Applications (later phase)'],
  ['monitor', 'The monitor itself: log storage, database, email'],
];

export function SubscriptionsTab() {
  const { data, mutate } = useSWR<{ categories: AlertCategory[]; allCategories: boolean }>('/alerts/subscriptions/me', fetcher);
  const [err, setErr] = useState<string | null>(null);
  if (!data) return <div className="muted">Loading…</div>;

  async function toggle(c: AlertCategory) {
    const cur = data!.categories;
    const next = cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c];
    setErr(null);
    try {
      await mutate(api('/alerts/subscriptions/me', { method: 'PUT', body: { categories: next } }), {
        optimisticData: { ...data!, categories: next },
        rollbackOnError: true,
      });
    } catch (e) {
      setErr(errorMessage(e));
    }
  }

  return (
    <section className="card" aria-label="My emails">
      <h2>Which alert emails do you get?</h2>
      {data.allCategories ? (
        <p className="muted">Administrators receive every alert email. There is nothing to choose.</p>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>Tick the groups you want emailed to your address.</p>
          {CATS.map(([c, label]) => (
            <label key={c} style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text)', marginBottom: 8 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={data.categories.includes(c)} onChange={() => void toggle(c)} />
              {label}
            </label>
          ))}
        </>
      )}
      {err && <div className="error" role="alert">{err}</div>}
    </section>
  );
}
