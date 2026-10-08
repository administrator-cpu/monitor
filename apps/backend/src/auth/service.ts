import type { Audit } from '../audit';
import type { Settings } from '../settings';
import { verifyAgainstDummy, verifyPassword } from './password';
import type { SessionStore } from './sessions';
import { SlidingWindowLimiter, UnknownUserTracker } from './throttle';
import type { UserRow, Users } from './users';

export interface LoginAttempt {
  username: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: number; user: UserRow }
  | { ok: false; status: 401 | 429; error: 'invalid_credentials' | 'too_many_attempts' };

export class AuthService {
  private readonly ipLimiter: SlidingWindowLimiter;
  private readonly unknownUsers: UnknownUserTracker;
  /** Serialises attempts per username so parallel guesses cannot race the lockout. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly users: Users,
    private readonly sessions: SessionStore,
    private readonly settings: Settings,
    private readonly audit: Audit,
    private readonly now: () => number = Date.now,
  ) {
    this.ipLimiter = new SlidingWindowLimiter(20, 10 * 60_000, now);
    this.unknownUsers = new UnknownUserTracker(now);
  }

  login(attempt: LoginAttempt): Promise<LoginResult> {
    const key = attempt.username.toLowerCase();
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(() => this.doLogin(attempt, key));
    const tail = run.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  private async doLogin(a: LoginAttempt, key: string): Promise<LoginResult> {
    const base = { username: a.username, ip: a.ip, userAgent: a.userAgent };

    if (!this.ipLimiter.hit(a.ip ?? 'unknown')) {
      this.audit.write({ ...base, event: 'login_failed', detail: { reason: 'ip_rate_limited' } });
      return { ok: false, status: 429, error: 'too_many_attempts' };
    }

    const user = this.users.getByUsername(a.username);
    const lockedUntil = Math.max(user?.locked_until ?? 0, this.unknownUsers.lockedUntil(key) ?? 0);
    if (lockedUntil > this.now()) {
      this.audit.write({
        ...base,
        userId: user?.id ?? null,
        event: 'login_locked',
        detail: { reason: 'attempt_while_locked', lockedUntil },
      });
      return { ok: false, status: 429, error: 'too_many_attempts' };
    }

    const valid =
      user && user.is_active === 1
        ? await verifyPassword(a.password, user.password_hash)
        : await verifyAgainstDummy(a.password);

    if (!valid || !user) {
      const maxFailures = this.settings.get('login.max_failures');
      const lockMs = this.settings.get('login.lock_minutes') * 60_000;
      let newlyLocked: number | null;
      if (user) {
        newlyLocked = this.users.recordFailure(user.id, maxFailures, lockMs).lockedUntil;
      } else {
        newlyLocked = this.unknownUsers.recordFailure(key, maxFailures, lockMs);
      }
      this.audit.write({
        ...base,
        userId: user?.id ?? null,
        event: 'login_failed',
        detail: {
          reason: !user ? 'unknown_user' : user.is_active !== 1 ? 'disabled' : 'bad_password',
        },
      });
      if (newlyLocked !== null) {
        this.audit.write({
          ...base,
          userId: user?.id ?? null,
          event: 'login_locked',
          detail: { reason: 'max_failures', lockedUntil: newlyLocked },
        });
      }
      return { ok: false, status: 401, error: 'invalid_credentials' };
    }

    this.users.recordLogin(user.id, a.ip);
    const { token, expiresAt } = this.sessions.create(user.id, a.ip, a.userAgent);
    this.audit.write({ ...base, userId: user.id, event: 'login_success' });
    const fresh = this.users.getById(user.id) as UserRow;
    return { ok: true, token, expiresAt, user: fresh };
  }
}
