'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { HostStatus } from '@cc/shared';
import { useLive } from '@/lib/live';

/** `?host=<id>` in the address; host 1 (this server) when absent or not a host id. */
export function useHostId(): number {
  const raw = useSearchParams().get('host');
  const n = Number(raw);
  return raw !== null && Number.isInteger(n) && n > 1 ? n : 1;
}

const NOTE: Partial<Record<HostStatus, string>> = { silent: ' (silent)', waiting: ' (waiting for agent)' };

/**
 * Picks the host the Host and Services pages show (phase 11 M2, the minimal switcher; M6 puts it
 * everywhere). Hidden while this server is the only host. The choice lives in the address, so a
 * link or a reload keeps it.
 */
export function HostSwitcher({ hostId }: { hostId: number }) {
  const { live } = useLive();
  const router = useRouter();
  const pathname = usePathname();
  const hosts = live?.hosts ?? [];
  if (hosts.length < 2 && hostId === 1) return null;
  const known = hosts.some((h) => h.id === hostId);
  return (
    <label className="host-switch">
      <span className="muted">Host</span>
      <select
        aria-label="Host"
        value={hostId}
        onChange={(e) => {
          const id = Number(e.target.value);
          router.replace(id === 1 ? pathname : `${pathname}?host=${id}`);
        }}
      >
        {hosts.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
            {h.kind === 'local' ? ' (this server)' : (NOTE[h.status] ?? '')}
          </option>
        ))}
        {!known && <option value={hostId}>Host {hostId}</option>}
      </select>
    </label>
  );
}
