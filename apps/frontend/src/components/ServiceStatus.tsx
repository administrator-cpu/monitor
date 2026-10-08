import type { ProcessState } from '@cc/shared';

export type Level = 'ok' | 'warn' | 'crit';

export function processLevel(p: ProcessState | null | undefined): Level {
  if (!p) return 'warn';
  if (p.status === 'online') return 'ok';
  if (p.status === 'launching' || p.status === 'stopping') return 'warn';
  return 'crit';
}

export function processLabel(p: ProcessState | null | undefined): string {
  if (!p) return 'unknown';
  if (p.instances === 0) return 'not running';
  if (p.instances > 1 && p.status === 'online') return `online · ${p.instancesOnline}/${p.instances}`;
  if (p.instances > 1) return `${p.status} · ${p.instancesOnline}/${p.instances} online`;
  return p.status;
}

export function StatusDot({ p }: { p: ProcessState | null | undefined }) {
  const lvl = processLevel(p);
  return <span className={`dot ${lvl}`} role="img" aria-label={processLabel(p)} />;
}
