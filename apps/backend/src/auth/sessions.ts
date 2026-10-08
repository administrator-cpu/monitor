import crypto from 'node:crypto';
import type { Db } from '../db';
import type { Settings } from '../settings';
import type { UserRow } from './users';

export interface SessionRow {
  id: string;
  user_id: number;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  ip: string | null;
  user_agent: string | null;
  revoked_at: number | null;
}

export type ValidateResult =
  | { ok: true; session: SessionRow; user: UserRow }
  | { ok: false; reason: 'unknown' | 'revoked' | 'expired' | 'idle' | 'disabled'; userId?: number };

/** Only the SHA-256 hash of a token is stored, never the token itself. */
export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

const TOUCH_INTERVAL_MS = 60_000;

export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly now: () => number = Date.now,
  ) {}

  create(
    userId: number,
    ip: string | null,
    userAgent: string | null,
  ): { token: string; expiresAt: number } {
    const token = crypto.randomBytes(32).toString('base64url');
    const ts = this.now();
    const expiresAt = ts + this.settings.get('session.absolute_hours') * 3_600_000;
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(hashToken(token), userId, ts, expiresAt, ts, ip, userAgent?.slice(0, 300) ?? null);
    return { token, expiresAt };
  }

  /**
   * Checks a presented token. Absolute and idle expiry are both enforced and an
   * expired session is revoked on the spot. `touch: false` is used by the
   * WebSocket re-check so an open tab does not defeat the idle timeout.
   */
  validate(token: string, opts: { touch?: boolean } = {}): ValidateResult {
    const touch = opts.touch ?? true;
    const id = hashToken(token);
    const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      SessionRow | undefined;
    if (!session) return { ok: false, reason: 'unknown' };
    if (session.revoked_at !== null) {
      return { ok: false, reason: 'revoked', userId: session.user_id };
    }
    const ts = this.now();
    if (ts >= session.expires_at) {
      this.revokeById(id);
      return { ok: false, reason: 'expired', userId: session.user_id };
    }
    const idleMs = this.settings.get('session.idle_hours') * 3_600_000;
    if (ts - session.last_seen_at > idleMs) {
      this.revokeById(id);
      return { ok: false, reason: 'idle', userId: session.user_id };
    }
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id) as
      UserRow | undefined;
    if (!user || user.is_active !== 1) {
      return { ok: false, reason: 'disabled', userId: session.user_id };
    }
    if (touch && ts - session.last_seen_at >= TOUCH_INTERVAL_MS) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(ts, id);
      session.last_seen_at = ts;
    }
    return { ok: true, session, user };
  }

  revokeByToken(token: string): boolean {
    return this.revokeById(hashToken(token));
  }

  private revokeById(id: string): boolean {
    const r = this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(this.now(), id);
    return r.changes > 0;
  }

  /** Revokes every live session of a user, optionally keeping one. Returns the count. */
  revokeAllForUser(userId: number, exceptId?: string): number {
    const r = this.db
      .prepare(
        `UPDATE sessions SET revoked_at = ?
         WHERE user_id = ? AND revoked_at IS NULL AND (? IS NULL OR id != ?)`,
      )
      .run(this.now(), userId, exceptId ?? null, exceptId ?? null);
    return r.changes;
  }

  /** Deletes sessions that expired more than 7 days ago (backend-schema.md section 9.1). */
  cleanup(): number {
    const cutoff = this.now() - 7 * 24 * 3_600_000;
    return this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(cutoff).changes;
  }
}
