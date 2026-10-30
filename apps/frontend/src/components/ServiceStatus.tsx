import type { ProcessState } from '@cc/shared';
import { duration } from '@/lib/format';

export type Level = 'ok' | 'warn' | 'crit' | 'off';

export function processLevel(p: ProcessState | null | undefined): Level {
  if (!p) return 'warn';
  if (p.stale) return 'off';
  if (p.status === 'online') return 'ok';
  if (p.status === 'launching' || p.status === 'stopping') return 'warn';
  return 'crit';
}

export function processLabel(p: ProcessState | null | undefined): string {
  if (!p) return 'unknown';
  if (p.stale) return 'unknown · no report from its host';
  if (p.instances === 0) return 'not running';
  if (p.instances > 1 && p.status === 'online') return `online · ${p.instancesOnline}/${p.instances}`;
  if (p.instances > 1) return `${p.status} · ${p.instancesOnline}/${p.instances} online`;
  return p.status;
}

export function StatusDot({ p }: { p: ProcessState | null | undefined }) {
  const lvl = processLevel(p);
  return <span className={`dot ${lvl}`} role="img" aria-label={processLabel(p)} />;
}

/** CPU, memory and uptime are worth showing: something is running and the figures are current. */
export function hasFigures(p: ProcessState | null | undefined): p is ProcessState {
  return Boolean(p && p.instances > 0 && !p.stale);
}

/** Uptime, as "~6d" when only Docker's rounded "Up 6 days" is known. */
export function uptimeText(p: ProcessState | null | undefined): string {
  if (!hasFigures(p)) return '—';
  return p.uptimeApprox ? `~${duration(p.uptimeS).split(' ')[0]}` : duration(p.uptimeS);
}
