import crypto from 'node:crypto';
import {
  AGENT_MAX_SKEW_MS,
  HOST_ONLINE_MS,
  LOCAL_HOST_ID,
  type HostDto,
  type HostIngestCounts,
  type HostKind,
  type HostOs,
  type HostStatus,
} from '@cc/shared';
import type { Db } from '../db';

export interface HostRow {
  id: number;
  name: string;
  kind: HostKind;
  os: HostOs;
  token_hash: string | null;
  enroll_hash: string | null;
  enroll_expires_at: number | null;
  agent_version: string | null;
  actions_enabled: number | null;
  last_seen_at: number | null;
  clock_skew_ms: number | null;
  created_at: number;
  created_by: number | null;
  revoked_at: number | null;
  notes: string | null;
}

export class HostConflictError extends Error {
  constructor(public readonly code: 'name_taken' | 'local_host' | 'revoked') {
    super(code);
  }
}

/** 32 random bytes, URL-safe. Only the SHA-256 hash is ever stored. */
export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** last_seen_at is written at most this often; the exact time is kept in memory. */
const TOUCH_EVERY_MS = 60_000;

export type EnrollResult =
  | { ok: true; host: HostRow; token: string; reEnrolled: boolean }
  | { ok: false; error: 'enroll_token_invalid' | 'enroll_token_expired' | 'os_mismatch' };

const emptyCounts = (): HostIngestCounts => ({
  metrics: 0,
  logs: 0,
  events: 0,
  app: 0,
  rejected: 0,
  logLines: 0,
  eventCount: 0,
});

/**
 * The `hosts` table with an in-memory index by token hash, so authenticating an agent request
 * costs no database read. Host 1 is the local Windows server and has no tokens.
 */
export class HostsRepo {
  private rows = new Map<number, HostRow>();
  private byToken = new Map<string, number>();
  private seen = new Map<number, number>();
  private touched = new Map<number, number>();
  private counts = new Map<number, HostIngestCounts>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.reload();
  }

  reload(): void {
    this.rows.clear();
    this.byToken.clear();
    for (const r of this.db.prepare('SELECT * FROM hosts ORDER BY id').all() as HostRow[])
      this.put(r);
  }

  private put(r: HostRow): void {
    const prev = this.rows.get(r.id);
    if (prev?.token_hash) this.byToken.delete(prev.token_hash);
    this.rows.set(r.id, r);
    if (r.token_hash) this.byToken.set(r.token_hash, r.id);
    if (r.last_seen_at !== null && (this.seen.get(r.id) ?? 0) < r.last_seen_at)
      this.seen.set(r.id, r.last_seen_at);
  }

  private fetch(id: number): HostRow {
    const r = this.db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow;
    this.put(r);
    return r;
  }

  get(id: number): HostRow | undefined {
    return this.rows.get(id);
  }

  list(): HostRow[] {
    return [...this.rows.values()].sort((a, b) => a.id - b.id);
  }

  /** Agent hosts whose token currently works. */
  enrolledAgents(): HostRow[] {
    return this.list().filter(
      (r) => r.kind === 'agent' && r.token_hash !== null && r.revoked_at === null,
    );
  }

  /** The host a bearer token belongs to, or undefined (unknown, rotated or revoked). */
  byBearer(token: string): HostRow | undefined {
    const id = this.byToken.get(hashToken(token));
    const r = id === undefined ? undefined : this.rows.get(id);
    return r && r.revoked_at === null ? r : undefined;
  }

  lastSeenAt(id: number): number | null {
    return this.seen.get(id) ?? this.rows.get(id)?.last_seen_at ?? null;
  }

  countsOf(id: number): HostIngestCounts {
    let c = this.counts.get(id);
    if (!c) {
      c = emptyCounts();
      this.counts.set(id, c);
    }
    return c;
  }

  private nameTaken(name: string, exceptId?: number): boolean {
    return [...this.rows.values()].some(
      (r) => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase(),
    );
  }

  /** Creates an agent host with a fresh enrollment token. */
  create(
    v: { name: string; os: HostOs; notes?: string | null; createdBy: number | null },
    enrollMinutes: number,
  ): {
    host: HostRow;
    token: string;
  } {
    if (this.nameTaken(v.name)) throw new HostConflictError('name_taken');
    const t = this.now();
    const token = newToken();
    const info = this.db
      .prepare(
        `INSERT INTO hosts (name, kind, os, enroll_hash, enroll_expires_at, created_at, created_by, notes)
         VALUES (?, 'agent', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        v.name,
        v.os,
        hashToken(token),
        t + enrollMinutes * 60_000,
        t,
        v.createdBy,
        v.notes ?? null,
      );
    return { host: this.fetch(Number(info.lastInsertRowid)), token };
  }

  /**
   * A new one-time token for re-enrollment (after a revoke, or to rotate the host token). Until an
   * agent uses it, the current host token keeps working; a revoked host stays revoked.
   */
  issueEnrollToken(id: number, enrollMinutes: number): { host: HostRow; token: string } {
    const r = this.rows.get(id);
    if (!r) throw new Error('not_found');
    if (r.kind === 'local') throw new HostConflictError('local_host');
    const token = newToken();
    this.db
      .prepare('UPDATE hosts SET enroll_hash = ?, enroll_expires_at = ? WHERE id = ?')
      .run(hashToken(token), this.now() + enrollMinutes * 60_000, id);
    return { host: this.fetch(id), token };
  }

  /** Exchanges a one-time token for a host token. The enrollment token can never be used again. */
  enroll(
    enrollToken: string,
    v: { hostname: string; os: HostOs; agentVersion: string },
  ): EnrollResult {
    const hash = hashToken(enrollToken);
    const r = this.db.prepare('SELECT * FROM hosts WHERE enroll_hash = ?').get(hash) as
      HostRow | undefined;
    if (!r || r.kind !== 'agent') return { ok: false, error: 'enroll_token_invalid' };
    const t = this.now();
    if (r.enroll_expires_at === null || r.enroll_expires_at <= t)
      return { ok: false, error: 'enroll_token_expired' };
    if (r.os !== v.os) return { ok: false, error: 'os_mismatch' };
    const token = newToken();
    const reEnrolled = r.token_hash !== null || r.revoked_at !== null || r.last_seen_at !== null;
    this.db
      .prepare(
        `UPDATE hosts SET token_hash = ?, enroll_hash = NULL, enroll_expires_at = NULL, revoked_at = NULL,
           agent_version = ?, last_seen_at = ?, clock_skew_ms = NULL,
           notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes END
         WHERE id = ? AND enroll_hash = ?`,
      )
      .run(hashToken(token), v.agentVersion, t, `Reported hostname: ${v.hostname}`, r.id, hash);
    this.seen.set(r.id, t);
    this.touched.set(r.id, t);
    return { ok: true, host: this.fetch(r.id), token, reEnrolled };
  }

  /** Clears both tokens: the agent gets 401 from its next request on. History is kept. */
  revoke(id: number): HostRow {
    const r = this.rows.get(id);
    if (!r) throw new Error('not_found');
    if (r.kind === 'local') throw new HostConflictError('local_host');
    this.db
      .prepare(
        'UPDATE hosts SET token_hash = NULL, enroll_hash = NULL, enroll_expires_at = NULL, revoked_at = ? WHERE id = ?',
      )
      .run(this.now(), id);
    return this.fetch(id);
  }

  update(id: number, patch: { name?: string; notes?: string | null }): HostRow {
    const r = this.rows.get(id);
    if (!r) throw new Error('not_found');
    if (r.kind === 'local' && patch.name !== undefined && patch.name !== r.name)
      throw new HostConflictError('local_host');
    if (patch.name !== undefined && this.nameTaken(patch.name, id))
      throw new HostConflictError('name_taken');
    this.db
      .prepare('UPDATE hosts SET name = ?, notes = ? WHERE id = ?')
      .run(patch.name ?? r.name, patch.notes === undefined ? r.notes : patch.notes, id);
    return this.fetch(id);
  }

  /**
   * Records an authenticated request. `skewMs` is agent clock minus monitor clock when known.
   * Returns true when the skew is beyond the limit, so the caller replaces agent timestamps.
   */
  touch(id: number, v: { agentVersion?: string; actions?: boolean; skewMs?: number }): boolean {
    const r = this.rows.get(id);
    if (!r) return false;
    const t = this.now();
    this.seen.set(id, t);
    const skewed = v.skewMs !== undefined && Math.abs(v.skewMs) > AGENT_MAX_SKEW_MS;
    const next = {
      agent_version: v.agentVersion ?? r.agent_version,
      actions_enabled: v.actions === undefined ? r.actions_enabled : v.actions ? 1 : 0,
      clock_skew_ms:
        v.skewMs === undefined ? r.clock_skew_ms : skewed ? Math.round(v.skewMs!) : null,
    };
    const changed =
      next.agent_version !== r.agent_version ||
      next.actions_enabled !== r.actions_enabled ||
      next.clock_skew_ms !== r.clock_skew_ms;
    if (changed || t - (this.touched.get(id) ?? 0) >= TOUCH_EVERY_MS) {
      this.db
        .prepare(
          'UPDATE hosts SET last_seen_at = ?, agent_version = ?, actions_enabled = ?, clock_skew_ms = ? WHERE id = ?',
        )
        .run(t, next.agent_version, next.actions_enabled, next.clock_skew_ms, id);
      this.touched.set(id, t);
      this.rows.set(id, { ...r, ...next, last_seen_at: t });
    }
    return skewed;
  }

  status(r: HostRow): HostStatus {
    if (r.kind === 'local') return 'local';
    if (r.revoked_at !== null) return 'revoked';
    if (r.token_hash === null) return 'waiting';
    const seen = this.lastSeenAt(r.id);
    return seen !== null && this.now() - seen <= HOST_ONLINE_MS ? 'online' : 'silent';
  }

  toDto(r: HostRow, latest: HostDto['latest'] = null): HostDto {
    const t = this.now();
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      os: r.os,
      status: this.status(r),
      enrolled: r.token_hash !== null && r.revoked_at === null,
      enrollExpiresAt:
        r.enroll_hash !== null && r.enroll_expires_at !== null && r.enroll_expires_at > t
          ? r.enroll_expires_at
          : null,
      agentVersion: r.agent_version,
      actionsEnabled: r.actions_enabled === null ? null : r.actions_enabled === 1,
      lastSeenAt: this.lastSeenAt(r.id),
      clockSkewMs: r.clock_skew_ms,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
      notes: r.notes,
      latest,
      counts: r.id === LOCAL_HOST_ID ? null : { ...this.countsOf(r.id) },
    };
  }
}
