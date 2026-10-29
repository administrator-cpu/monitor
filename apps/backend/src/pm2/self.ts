import type { Pm2Proc } from './types';

/** PM2 names the monitor itself runs under. */
export const SELF_NAMES = new Set(['monitor-api']);

/** PM2 id of this very process (PM2 puts it in the `pm_id` environment variable), null outside PM2. */
export function envPmId(): number | null {
  const v = process.env.pm_id;
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : null;
}

/** True when this PM2 entry is the monitor itself, by name or by PM2 id. */
export function isSelf(p: Pm2Proc, ownPmId: number | null): boolean {
  return SELF_NAMES.has(p.name.toLowerCase()) || (ownPmId !== null && p.pmId === ownPmId);
}
