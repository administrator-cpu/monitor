import type { Db } from '../db';
import type { CollectorDef } from '../scheduler';
import type { StateStore } from '../state';
import { runPowerShell } from './powershell';

const MESSAGE_MAX = 2000;
const FIRST_LOOKBACK_MS = 3_600_000;
const OVERLAP_MS = 60_000;

/**
 * The script is fixed. Its only input is one integer (the start time in epoch milliseconds),
 * checked to be a safe integer before it is written into the text, so there is no injection surface.
 */
export function eventLogScript(sinceMs: number): string {
  if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) throw new Error('invalid start time');
  return [
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;`,
    `$ErrorActionPreference = 'SilentlyContinue';`,
    `$st = [DateTimeOffset]::FromUnixTimeMilliseconds(${sinceMs}).UtcDateTime;`,
    `$e = Get-WinEvent -FilterHashtable @{ LogName = 'System','Application'; Level = 1,2,3; StartTime = $st } -MaxEvents 200;`,
    `$out = @($e | ForEach-Object { [pscustomobject]@{`,
    `log = $_.LogName; rec = $_.RecordId;`,
    `ts = [DateTimeOffset]::new($_.TimeCreated.ToUniversalTime()).ToUnixTimeMilliseconds();`,
    `level = $_.Level; provider = $_.ProviderName; id = $_.Id;`,
    `msg = $(if ($_.Message) { $_.Message.Substring(0, [Math]::Min(${MESSAGE_MAX}, $_.Message.Length)) } else { $null }) } });`,
    `ConvertTo-Json -Compress -InputObject $out`,
  ].join(' ');
}

export interface ParsedEvent {
  logName: string;
  recordId: number;
  ts: number;
  level: 'critical' | 'error' | 'warning';
  provider: string | null;
  eventId: number | null;
  message: string | null;
}

const LEVELS: Record<number, ParsedEvent['level']> = { 1: 'critical', 2: 'error', 3: 'warning' };

/** Tolerates an empty answer, a single object (PowerShell 5 unwraps one-item arrays) and junk entries. */
export function parseEventLog(stdout: string): ParsedEvent[] {
  const text = stdout.replace(/^﻿/, '').trim();
  if (text === '') return [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Event Log output was not valid JSON');
  }
  const list = Array.isArray(json) ? json : [json];
  const out: ParsedEvent[] = [];
  for (const x of list) {
    if (typeof x !== 'object' || x === null) continue;
    const o = x as Record<string, unknown>;
    const level = typeof o.level === 'number' ? LEVELS[o.level] : undefined;
    if (typeof o.log !== 'string' || !['System', 'Application'].includes(o.log)) continue;
    if (!Number.isSafeInteger(o.rec) || !Number.isFinite(o.ts) || !level) continue;
    out.push({
      logName: o.log,
      recordId: o.rec as number,
      ts: o.ts as number,
      level,
      provider: typeof o.provider === 'string' ? o.provider.slice(0, 200) : null,
      eventId: Number.isSafeInteger(o.id) ? (o.id as number) : null,
      message: typeof o.msg === 'string' ? o.msg.slice(0, MESSAGE_MAX) : null,
    });
  }
  return out;
}

export interface EventLogDeps {
  db: Db;
  state: StateStore;
  now?: () => number;
  ps?: (script: string) => Promise<string>;
}

/**
 * Every 60 s: reads System and Application events of level critical, error and warning newer than
 * the last one stored (a minute of overlap, duplicates are ignored by the unique key), stores them,
 * and tells the state store when the newest critical one happened for the alert rule.
 */
export function eventLogCollector(d: EventLogDeps): CollectorDef {
  const now = d.now ?? Date.now;
  const ps = d.ps ?? ((s: string) => runPowerShell(s, 40_000));
  const insert = d.db.prepare(
    `INSERT OR IGNORE INTO windows_events (log_name, record_id, ts, level, provider, event_id, message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  return {
    name: 'eventlog',
    intervalMs: 60_000,
    timeoutMs: 45_000,
    async run() {
      const last = (d.db.prepare('SELECT MAX(ts) AS t FROM windows_events').get() as { t: number | null }).t;
      const since = last === null ? now() - FIRST_LOOKBACK_MS : Math.max(0, last - OVERLAP_MS);
      const events = parseEventLog(await ps(eventLogScript(Math.floor(since))));
      let added = 0;
      d.db.transaction(() => {
        for (const e of events) {
          added += insert.run(e.logName, e.recordId, e.ts, e.level, e.provider, e.eventId, e.message).changes;
        }
      })();
      const t = now();
      const crit = d.db
        .prepare(`SELECT ts, log_name, provider, event_id FROM windows_events WHERE level = 'critical' ORDER BY ts DESC LIMIT 1`)
        .get() as { ts: number; log_name: string; provider: string | null; event_id: number | null } | undefined;
      const recent = (
        d.db.prepare(`SELECT COUNT(*) AS n FROM windows_events WHERE level = 'critical' AND ts >= ?`).get(t - 300_000) as { n: number }
      ).n;
      d.state.setEventLog({
        at: t,
        added,
        lastCritical: crit ? { ts: crit.ts, logName: crit.log_name, provider: crit.provider, eventId: crit.event_id } : null,
        criticalLast5m: recent,
      });
    },
  };
}
