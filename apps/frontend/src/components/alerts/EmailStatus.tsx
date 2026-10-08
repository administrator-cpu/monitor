'use client';

import { useState } from 'react';
import useSWR from 'swr';
import type { AlertStatusResponse, TestEmailResponse } from '@cc/shared';
import { api, errorMessage, fetcher } from '@/lib/api';
import { timeAgo } from '@/lib/format';

export function EmailStatus({ isAdmin }: { isAdmin: boolean }) {
  const { data, mutate } = useSWR<AlertStatusResponse>('/alerts/status', fetcher, { refreshInterval: 15_000 });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  if (!data) return null;
  const e = data.email;

  async function test() {
    setBusy(true);
    setResult(null);
    try {
      const r = await api<TestEmailResponse>('/alerts/test-email', { method: 'POST' });
      setResult(r.status === 'sent' ? { ok: true, text: 'Test email sent to your own address.' } : { ok: false, text: `Sending failed: ${r.error ?? 'unknown error'}` });
      void mutate();
    } catch (err) {
      setResult({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!e.configured && (
        <div className="banner warn" role="status" data-testid="email-not-configured">
          Email is not set up, so alerts appear here but nobody is emailed.
          {isAdmin && e.missing.length > 0 && <> Missing: {e.missing.join(', ')}.</>}
        </div>
      )}
      {e.configured && e.failing && (
        <div className="banner crit" role="alert" data-testid="email-failing">
          Alert emails are failing ({e.consecutiveFailures} attempts in a row).
          {isAdmin && e.lastError && <> Last error: {e.lastError}</>}
        </div>
      )}
      {isAdmin && (
        <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <button className="btn small" onClick={() => void test()} disabled={busy || !e.configured}>
            {busy ? 'Sending…' : 'Send me a test email'}
          </button>
          <span className="muted">
            {e.configured ? `From ${e.from} · last sent ${timeAgo(e.lastSentAt)}` : 'Not configured'}
          </span>
          {result && (
            <span className={result.ok ? 'notice' : 'error'} role="status" style={{ margin: 0 }}>
              {result.text}
            </span>
          )}
        </div>
      )}
      {isAdmin && e.warnings.map((w) => (
        <div key={w} className="banner warn" role="status">{w}</div>
      ))}
    </>
  );
}
