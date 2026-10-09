import type { ServiceDto } from '@cc/shared';
import type { Db } from '../db';

export interface ServiceRow {
  id: number;
  name: string;
  pm2_name: string;
  nginx_match: string | null;
  public_url: string | null;
  agent_enabled: number;
  first_seen_at: number;
  last_seen_at: number;
  is_archived: number;
  notes: string | null;
  git_repo: string | null;
  git_branch: string;
  git_path: string | null;
}

export class ServiceConflictError extends Error {
  constructor(public readonly code: 'name_taken' | 'service_active') {
    super(code);
  }
}

/** Last-seen is written at most this often per service. */
const TOUCH_EVERY_MS = 60_000;

/** The `services` table plus an in-memory index by PM2 name. Services are never created by hand. */
export class ServicesRepo {
  private byPm2 = new Map<string, ServiceRow>();
  private touched = new Map<number, number>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly staleHours: () => number = () => 24,
  ) {
    this.reload();
  }

  reload(): void {
    this.byPm2.clear();
    for (const r of this.db.prepare('SELECT * FROM services WHERE id > 0').all() as ServiceRow[]) {
      this.byPm2.set(r.pm2_name, r);
    }
  }

  get(id: number): ServiceRow | undefined {
    for (const r of this.byPm2.values()) if (r.id === id) return r;
    return undefined;
  }

  getByPm2Name(name: string): ServiceRow | undefined {
    return this.byPm2.get(name);
  }

  list(includeArchived = false): ServiceRow[] {
    return [...this.byPm2.values()]
      .filter((r) => includeArchived || r.is_archived === 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Registers a PM2 process name the first time it is seen and records every later sighting.
   * An archived service that PM2 lists again becomes active again.
   */
  discover(pm2Name: string): ServiceRow {
    const t = this.now();
    let row = this.byPm2.get(pm2Name);
    if (!row) {
      const name = this.freeName(pm2Name);
      const info = this.db
        .prepare(
          `INSERT INTO services (name, pm2_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)`,
        )
        .run(name, pm2Name, t, t);
      row = this.db.prepare('SELECT * FROM services WHERE id = ?').get(info.lastInsertRowid) as ServiceRow;
      this.byPm2.set(pm2Name, row);
      this.touched.set(row.id, t);
      return row;
    }
    if (row.is_archived === 1) {
      this.db.prepare('UPDATE services SET is_archived = 0, last_seen_at = ? WHERE id = ?').run(t, row.id);
      row = { ...row, is_archived: 0, last_seen_at: t };
      this.byPm2.set(pm2Name, row);
      this.touched.set(row.id, t);
    } else if (t - (this.touched.get(row.id) ?? 0) >= TOUCH_EVERY_MS) {
      this.db.prepare('UPDATE services SET last_seen_at = ? WHERE id = ?').run(t, row.id);
      row = { ...row, last_seen_at: t };
      this.byPm2.set(pm2Name, row);
      this.touched.set(row.id, t);
    }
    return row;
  }

  /** Set on the first valid agent report; never cleared by the monitor. */
  markAgentEnabled(id: number): void {
    const row = this.get(id);
    if (!row || row.agent_enabled === 1) return;
    this.db.prepare('UPDATE services SET agent_enabled = 1 WHERE id = ?').run(id);
    this.byPm2.set(row.pm2_name, { ...row, agent_enabled: 1 });
  }

  /** The display name starts as the PM2 name; if an admin already uses it, a suffix is added. */
  private freeName(base: string): string {
    const taken = new Set([...this.byPm2.values()].map((r) => r.name.toLowerCase()));
    if (!taken.has(base.toLowerCase()) && base !== '_unattributed') return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base} (${i})`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${base} (${Date.now()})`;
  }

  update(
    id: number,
    patch: {
      name?: string;
      publicUrl?: string | null;
      nginxMatch?: string | null;
      notes?: string | null;
      isArchived?: boolean;
      gitRepo?: string | null;
      gitBranch?: string;
      gitPath?: string | null;
    },
    livePm2Names: ReadonlySet<string>,
  ): ServiceRow {
    const row = this.get(id);
    if (!row) throw new Error('not_found');
    if (patch.isArchived === true && livePm2Names.has(row.pm2_name)) {
      // Archiving something PM2 still runs would be undone by the next discovery cycle.
      throw new ServiceConflictError('service_active');
    }
    if (patch.name !== undefined) {
      const clash = [...this.byPm2.values()].find(
        (r) => r.id !== id && r.name.toLowerCase() === patch.name!.toLowerCase(),
      );
      if (clash || patch.name === '_unattributed') throw new ServiceConflictError('name_taken');
    }
    const next = {
      name: patch.name ?? row.name,
      public_url: patch.publicUrl === undefined ? row.public_url : patch.publicUrl,
      nginx_match: patch.nginxMatch === undefined ? row.nginx_match : patch.nginxMatch,
      notes: patch.notes === undefined ? row.notes : patch.notes,
      is_archived: patch.isArchived === undefined ? row.is_archived : patch.isArchived ? 1 : 0,
      git_repo: patch.gitRepo === undefined ? row.git_repo : patch.gitRepo,
      git_branch: patch.gitBranch ?? row.git_branch,
      git_path: patch.gitPath === undefined ? row.git_path : patch.gitPath,
    };
    this.db
      .prepare(
        `UPDATE services SET name = ?, public_url = ?, nginx_match = ?, notes = ?, is_archived = ?,
           git_repo = ?, git_branch = ?, git_path = ? WHERE id = ?`,
      )
      .run(next.name, next.public_url, next.nginx_match, next.notes, next.is_archived, next.git_repo, next.git_branch, next.git_path, id);
    const updated = { ...row, ...next };
    this.byPm2.set(row.pm2_name, updated);
    return updated;
  }

  toDto(r: ServiceRow): ServiceDto {
    const staleMs = this.staleHours() * 3_600_000;
    return {
      id: r.id,
      name: r.name,
      pm2Name: r.pm2_name,
      nginxMatch: r.nginx_match,
      publicUrl: r.public_url,
      agentEnabled: r.agent_enabled === 1,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      isArchived: r.is_archived === 1,
      notes: r.notes,
      gitRepo: r.git_repo,
      gitBranch: r.git_branch,
      gitPath: r.git_path,
      stale: this.now() - r.last_seen_at > staleMs,
    };
  }
}
