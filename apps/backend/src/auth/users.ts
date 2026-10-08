import type { CreateUserInput, Role, UpdateUserInput, UserDto } from '@cc/shared';
import type { Db } from '../db';

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  email: string;
  phone: string | null;
  notes: string | null;
  role: Role;
  is_active: number;
  password_hash: string;
  password_changed_at: number;
  must_change_password: number;
  failed_attempts: number;
  locked_until: number | null;
  last_login_at: number | null;
  last_login_ip: string | null;
  created_at: number;
  updated_at: number;
}

export function toUserDto(u: UserRow): UserDto {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    phone: u.phone,
    notes: u.notes,
    role: u.role,
    isActive: u.is_active === 1,
    mustChangePassword: u.must_change_password === 1,
    lastLoginAt: u.last_login_at,
    lastLoginIp: u.last_login_ip,
    createdAt: u.created_at,
  };
}

export class DuplicateUserError extends Error {
  constructor(public readonly field: 'username' | 'email') {
    super(`${field}_taken`);
  }
}

export class Users {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  getById(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  getByUsername(username: string): UserRow | undefined {
    return this.db
      .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
      .get(username) as UserRow | undefined;
  }

  list(): UserRow[] {
    return this.db
      .prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE')
      .all() as UserRow[];
  }

  countActiveAdmins(): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1`)
      .get() as { n: number };
    return r.n;
  }

  create(input: Omit<CreateUserInput, 'password'> & { passwordHash: string }): UserRow {
    const ts = this.now();
    // Checked explicitly so the reported field is deterministic when both collide.
    if (this.getByUsername(input.username)) throw new DuplicateUserError('username');
    if (this.db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(input.email)) {
      throw new DuplicateUserError('email');
    }
    try {
      const info = this.db
        .prepare(
          `INSERT INTO users (username, display_name, email, phone, notes, role, is_active,
             password_hash, password_changed_at, must_change_password, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.username,
          input.displayName,
          input.email,
          input.phone ?? null,
          input.notes ?? null,
          input.role,
          input.passwordHash,
          ts,
          input.mustChangePassword ? 1 : 0,
          ts,
          ts,
        );
      return this.getById(Number(info.lastInsertRowid)) as UserRow;
    } catch (e) {
      throw mapUnique(e);
    }
  }

  update(id: number, patch: UpdateUserInput): UserRow {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    const map: [keyof UpdateUserInput, string, (v: never) => string | number | null][] = [
      ['displayName', 'display_name', (v) => v as string],
      ['email', 'email', (v) => v as string],
      ['phone', 'phone', (v) => (v as string | null) ?? null],
      ['notes', 'notes', (v) => (v as string | null) ?? null],
      ['role', 'role', (v) => v as string],
      ['isActive', 'is_active', (v) => ((v as boolean) ? 1 : 0)],
    ];
    for (const [key, col, conv] of map) {
      if (patch[key] !== undefined) {
        sets.push(`${col} = ?`);
        args.push(conv(patch[key] as never));
      }
    }
    if (sets.length === 0) return this.getById(id) as UserRow;
    sets.push('updated_at = ?');
    args.push(this.now(), id);
    try {
      this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    } catch (e) {
      throw mapUnique(e);
    }
    return this.getById(id) as UserRow;
  }

  setPassword(id: number, passwordHash: string, mustChange: boolean): void {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = ?,
           failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(passwordHash, ts, mustChange ? 1 : 0, ts, id);
  }

  recordFailure(id: number, maxFailures: number, lockMs: number): { lockedUntil: number | null } {
    const ts = this.now();
    const row = this.getById(id);
    if (!row) return { lockedUntil: null };
    const attempts = row.failed_attempts + 1;
    if (attempts >= maxFailures) {
      const lockedUntil = ts + lockMs;
      this.db
        .prepare(
          'UPDATE users SET failed_attempts = 0, locked_until = ?, updated_at = ? WHERE id = ?',
        )
        .run(lockedUntil, ts, id);
      return { lockedUntil };
    }
    this.db
      .prepare('UPDATE users SET failed_attempts = ?, updated_at = ? WHERE id = ?')
      .run(attempts, ts, id);
    return { lockedUntil: null };
  }

  recordLogin(id: number, ip: string | null): void {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?,
           last_login_ip = ?, updated_at = ? WHERE id = ?`,
      )
      .run(ts, ip, ts, id);
  }
}

function mapUnique(e: unknown): unknown {
  const msg = e instanceof Error ? e.message : '';
  if (/UNIQUE constraint failed: users\.username/.test(msg))
    return new DuplicateUserError('username');
  if (/UNIQUE constraint failed: users\.email/.test(msg)) return new DuplicateUserError('email');
  return e;
}
