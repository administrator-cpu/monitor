import type { SettingEntry, SettingValue } from '@cc/shared';
import type { Db } from './db';

interface NumberDef {
  type: 'number';
  default: number;
  int?: boolean;
  min?: number;
  max?: number;
}

interface StringDef {
  type: 'string';
  default: string | null;
  /** Returns the normalised value or throws a SettingsError. */
  normalize(v: string): string;
}

/** Sender: `alerts@example.com` or `Name <alerts@example.com>`. No line breaks (header injection). */
function normalizeFrom(v: string): string {
  const s = v.trim();
  const ok =
    /^[^\r\n<>@]+<[^\s<>@,;]+@[^\s<>@,;]+>$/.test(s) || /^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+$/.test(s);
  if (!ok || s.length > 200) {
    throw new SettingsError('invalid_value', 'alert.from: use "name@example.com" or "Name <name@example.com>"');
  }
  return s;
}

/** `1.2.3`; the lowest agent version the ingest API accepts. */
function normalizeVersion(v: string): string {
  const s = v.trim();
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(s)) {
    throw new SettingsError('invalid_value', 'hosts.min_agent_version: use a version such as 0.1.0');
  }
  return s;
}

function normalizeUrl(v: string): string {
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new SettingsError('invalid_value', 'alert.dashboard_url: not a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new SettingsError('invalid_value', 'alert.dashboard_url: must start with http:// or https://');
  }
  if (u.username || u.password) {
    throw new SettingsError('invalid_value', 'alert.dashboard_url: must not contain credentials');
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * Tunables from backend-schema.md section 10. Defaults live in code so a fresh database needs no
 * seed rows; admin edits are stored in `settings`. Sending `null` restores the default.
 */
export const SETTING_DEFS = {
  'retention.metrics_raw_hours': { type: 'number', default: 24, min: 1, max: 168 },
  'retention.metrics_days': { type: 'number', default: 7, int: true, min: 1, max: 90 },
  'retention.events_days': { type: 'number', default: 7, int: true, min: 1, max: 90 },
  'retention.alerts_days': { type: 'number', default: 90, int: true, min: 1, max: 730 },
  'retention.audit_days': { type: 'number', default: 365, int: true, min: 1, max: 3650 },
  /** Resend delivery counts and webhook ids older than this are deleted. */
  'retention.email_days': { type: 'number', default: 30, int: true, min: 1, max: 365 },
  /** Nightly database backups kept in BACKUP_DIR (H7). */
  'backup.keep': { type: 'number', default: 14, int: true, min: 1, max: 365 },
  'logs.retention_hours': { type: 'number', default: 24, min: 1, max: 168 },
  'logs.volume_threshold_pct': { type: 'number', default: 85, min: 50, max: 99 },
  'logs.ring_buffer_lines': { type: 'number', default: 5000, int: true, min: 100, max: 100000 },
  'logs.search_max_results': { type: 'number', default: 5000, int: true, min: 100, max: 50000 },
  'session.absolute_hours': { type: 'number', default: 12, min: 0.25, max: 720 },
  'session.idle_hours': { type: 'number', default: 2, min: 0.1, max: 720 },
  'login.max_failures': { type: 'number', default: 5, int: true, min: 1, max: 100 },
  'login.lock_minutes': { type: 'number', default: 15, min: 1, max: 1440 },
  'alert.reminder_minutes': { type: 'number', default: 60, min: 1, max: 10080 },
  'alert.from': { type: 'string', default: null, normalize: normalizeFrom },
  'alert.dashboard_url': { type: 'string', default: null, normalize: normalizeUrl },
  'pm2.stale_hours': { type: 'number', default: 24, min: 1, max: 720 },
  /** A service PM2 has not listed for this long is archived automatically. 0 turns it off. */
  'pm2.auto_archive_minutes': { type: 'number', default: 15, int: true, min: 0, max: 10080 },
  /** How often GitHub is asked about each service that has a repository set. */
  'github.poll_minutes': { type: 'number', default: 5, int: true, min: 1, max: 1440 },
  /** Stop from the dashboard silences that service's "service down" alert for this long. 0 turns it off. */
  'actions.stop_mute_minutes': { type: 'number', default: 30, int: true, min: 0, max: 1440 },
  /** Agents older than this get 426 and are audited (phase 11). None: every version is accepted. */
  'hosts.min_agent_version': { type: 'string', default: null, normalize: normalizeVersion },
  /** How long a new enrollment token works (phase 11). */
  'hosts.enroll_minutes': { type: 'number', default: 60, int: true, min: 5, max: 1440 },
  'agent.max_tenants_per_report': { type: 'number', default: 50, int: true, min: 1, max: 500 },
  'mongo.slow_ms': { type: 'number', default: 100, int: true, min: 1, max: 60000 },
} satisfies Record<string, NumberDef | StringDef>;

export type SettingKey = keyof typeof SETTING_DEFS;
export type NumericSettingKey = {
  [K in SettingKey]: (typeof SETTING_DEFS)[K] extends { type: 'number' } ? K : never;
}[SettingKey];
export type StringSettingKey = {
  [K in SettingKey]: (typeof SETTING_DEFS)[K] extends { type: 'string' } ? K : never;
}[SettingKey];

const defs: Record<string, NumberDef | StringDef> = SETTING_DEFS;

export class SettingsError extends Error {
  constructor(
    public readonly code: 'unknown_key' | 'invalid_value',
    message: string,
  ) {
    super(message);
  }
}

interface Row {
  key: string;
  value: string;
  updated_at: number;
}

type Stored = number | string;

/** Settings cached in memory; the cache is updated on every write. */
export class Settings {
  private cache = new Map<string, { value: Stored; updatedAt: number }>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.reload();
  }

  reload(): void {
    this.cache.clear();
    const rows = this.db.prepare('SELECT key, value, updated_at FROM settings').all() as Row[];
    for (const r of rows) {
      const def = defs[r.key];
      if (!def) continue;
      try {
        const v: unknown = JSON.parse(r.value);
        if (def.type === 'number' && typeof v === 'number' && Number.isFinite(v)) {
          this.cache.set(r.key, { value: v, updatedAt: r.updated_at });
        } else if (def.type === 'string' && typeof v === 'string') {
          this.cache.set(r.key, { value: v, updatedAt: r.updated_at });
        }
      } catch {
        // a corrupt row falls back to the default
      }
    }
  }

  get(key: NumericSettingKey): number {
    const def = defs[key];
    if (!def || def.type !== 'number') throw new SettingsError('unknown_key', `Unknown setting: ${key}`);
    return (this.cache.get(key)?.value as number | undefined) ?? def.default;
  }

  /** The stored text value, or null when unset. */
  getString(key: StringSettingKey): string | null {
    const def = defs[key];
    if (!def || def.type !== 'string') throw new SettingsError('unknown_key', `Unknown setting: ${key}`);
    return (this.cache.get(key)?.value as string | undefined) ?? def.default;
  }

  /** Validates a patch and returns what would be stored (null = remove, restoring the default). */
  private validate(patch: Record<string, SettingValue>): Map<string, Stored | null> {
    const out = new Map<string, Stored | null>();
    for (const [key, value] of Object.entries(patch)) {
      const def = defs[key];
      if (!def) throw new SettingsError('unknown_key', `Unknown setting: ${key}`);
      if (value === null) {
        out.set(key, null);
        continue;
      }
      if (def.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new SettingsError('invalid_value', `${key}: must be a number`);
        }
        if (def.int && !Number.isInteger(value)) {
          throw new SettingsError('invalid_value', `${key}: must be an integer`);
        }
        if (def.min !== undefined && value < def.min) {
          throw new SettingsError('invalid_value', `${key}: must be at least ${def.min}`);
        }
        if (def.max !== undefined && value > def.max) {
          throw new SettingsError('invalid_value', `${key}: must be at most ${def.max}`);
        }
        out.set(key, value);
      } else {
        if (typeof value !== 'string') {
          throw new SettingsError('invalid_value', `${key}: must be text`);
        }
        out.set(key, value.trim() === '' ? null : def.normalize(value));
      }
    }
    return out;
  }

  /** Validates and stores several keys atomically. Returns the previous and new values. */
  setMany(
    patch: Record<string, SettingValue>,
    userId: number | null,
  ): Record<string, { from: Stored | null; to: Stored | null }> {
    const valid = this.validate(patch);
    const changes: Record<string, { from: Stored | null; to: Stored | null }> = {};
    const ts = this.now();
    const upsert = this.db.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    );
    const remove = this.db.prepare('DELETE FROM settings WHERE key = ?');
    this.db.transaction(() => {
      for (const [key, value] of valid) {
        changes[key] = { from: this.cache.get(key)?.value ?? defs[key]?.default ?? null, to: value };
        if (value === null) remove.run(key);
        else upsert.run(key, JSON.stringify(value), ts, userId);
      }
    })();
    for (const [key, value] of valid) {
      if (value === null) this.cache.delete(key);
      else this.cache.set(key, { value, updatedAt: ts });
    }
    return changes;
  }

  all(): SettingEntry[] {
    return Object.entries(defs).map(([key, def]) => {
      const cached = this.cache.get(key);
      if (def.type === 'number') {
        return {
          key,
          type: 'number' as const,
          value: (cached?.value as number | undefined) ?? def.default,
          default: def.default,
          updatedAt: cached?.updatedAt ?? null,
          min: def.min,
          max: def.max,
          integer: def.int === true,
        };
      }
      return {
        key,
        type: 'string' as const,
        value: (cached?.value as string | undefined) ?? def.default,
        default: def.default,
        updatedAt: cached?.updatedAt ?? null,
      };
    });
  }
}
