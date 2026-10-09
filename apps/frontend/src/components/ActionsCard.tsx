'use client';

import { useState } from 'react';
import type { ServiceAction, ServiceActionResponse, ServiceDto } from '@cc/shared';
import { api, ApiError, errorMessage } from '@/lib/api';

const LABEL: Record<ServiceAction, string> = { restart: 'Restart', stop: 'Stop', start: 'Start' };

const CONFIRM: Record<ServiceAction, (name: string, muteMin: number) => string> = {
  restart: (n) => `Restart ${n}? Open requests will be cut and the service is briefly unavailable.`,
  stop: (n, m) =>
    `Stop ${n}? It will stay down until someone starts it.${m > 0 ? ` Its "service down" alert is silenced for ${m} minutes.` : ''}`,
  start: (n) => `Start ${n}?`,
};

/** Start, stop and restart. Shown only to people allowed to operate; the server checks again. */
export function ActionsCard({
  service,
  status,
  operable,
  onDone,
}: {
  service: ServiceDto;
  /** PM2 status of the service now, e.g. online or stopped. */
  status: string | null;
  operable: { ok: boolean; reason: string | null };
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<ServiceAction | null>(null);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const running = status === 'online' || status === 'launching';

  async function run(action: ServiceAction) {
    if (!window.confirm(CONFIRM[action](service.name, 30))) return;
    setBusy(action);
    setMsg(null);
    try {
      const r = await api<ServiceActionResponse>(`/services/${service.id}/actions`, { method: 'POST', body: { action } });
      setMsg({
        text: r.verified
          ? `${LABEL[action]} done. The service is ${r.status}.${r.mutedMinutes > 0 ? ` Its "service down" alert is silenced for ${r.mutedMinutes} minutes (or until you start it).` : ''}`
          : `PM2 accepted the command, but the service still shows as ${r.status}. Check again in a moment.`,
        error: !r.verified,
      });
      onDone();
    } catch (e) {
      const text = e instanceof ApiError && e.code === 'cooldown' ? 'Please wait a few seconds between actions on the same service.' : errorMessage(e);
      setMsg({ text, error: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" aria-label="Actions" style={{ marginTop: 14 }}>
      <h2>Actions</h2>
      {!operable.ok ? (
        <div className="muted">{operable.reason ?? 'This service cannot be operated from here.'}</div>
      ) : (
        <div className="row">
          <button className="btn" disabled={busy !== null} onClick={() => void run('restart')}>
            {busy === 'restart' ? 'Restarting…' : 'Restart'}
          </button>
          {running ? (
            <button className="btn danger" disabled={busy !== null} onClick={() => void run('stop')}>
              {busy === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button className="btn primary" disabled={busy !== null} onClick={() => void run('start')}>
              {busy === 'start' ? 'Starting…' : 'Start'}
            </button>
          )}
        </div>
      )}
      {msg && (
        <div className={msg.error ? 'error' : 'notice'} role={msg.error ? 'alert' : 'status'} style={{ marginTop: 8 }}>
          {msg.text}
        </div>
      )}
    </section>
  );
}
