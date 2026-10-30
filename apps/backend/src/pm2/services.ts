import { LOCAL_HOST_ID, type ServiceDto, type ServiceKind } from '@cc/shared';
import type { Db } from '../db';

export interface ServiceRow {
  id: number;
  host_id: number;
  kind: ServiceKind;
  name: string;
  /** The PM2 name on host 1; `<project>/<service>` for a container on an agent host. */
  source_key: string;
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
  log_excluded: number;
}

const keyOf = (hostId: number, sourceKey: string): string => `${hostId}\u0000${sourceKey}`;

export class ServiceConflictError extends Error {
  constructor(public readonly code: 'name_taken' | 'service_active') {
    super(code);
  }
}

/** Last-seen is written at most this often per service. */
const TOUCH_EVERY_MS = 60_000;

/**
 * The `services` table plus an in-memory index by (host, source key). Services are never created
 * by hand: PM2 discovers them on host 1, an agent's container list on other hosts (M2).
 */
export class ServicesRepo {
  private byKey = new Map<string, ServiceRow>();
  private touched = new Map<number, number>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly staleHours: () => number = () => 24,
  ) {
    this.reload();
  }

  reload(): void {
    this.byKey.clear();
    for (const r of this.db.prepare('SELECT * FROM services WHERE id > 0').all() as ServiceRow[]) {
      this.byKey.set(keyOf(r.host_id, r.source_key), r);
    }
  }

  private put(r: ServiceRow): void {
    this.byKey.set(keyOf(r.host_id, r.source_key), r);
  }

  get(id: number): ServiceRow | undefined {
    for (const r of this.byKey.values()) if (r.id === id) return r;
    return undefined;
  }

  getBySource(hostId: number, sourceKey: string): ServiceRow | undefined {
    return this.byKey.get(keyOf(hostId, sourceKey));
  }

  /** A PM2 process on host 1. */
  getByPm2Name(name: string): ServiceRow | undefined {
    const r = this.getBySource(LOCAL_HOST_ID, name);
    return r?.kind === 'pm2' ? r : undefined;
  }

  /**
   * Services of one host, host 1 unless asked otherwise, so every caller that predates phase 11
   * (PM2, Nginx, GitHub, log folders) keeps seeing exactly the services it saw before.
   */
  list(includeArchived = false, hostId: number | 'all' = LOCAL_HOST_ID): ServiceRow[] {
    return [...this.byKey.values()]
      .filter((r) => (hostId === 'all' || r.host_id === hostId) && (includeArchived || r.is_archived === 0))
      .sort((a, b) => a.host_id - b.host_id || a.name.localeCompare(b.name));
  }

  /**
   * Registers a source key the first time it is seen and records every later sighting. Without
   * options this is a PM2 process on host 1. An archived service that is listed again becomes
   * active again.
   */
  discover(sourceKey: string, opts: { hostId?: number; kind?: 'pm2' | 'container' } = {}): ServiceRow {
    const hostId = opts.hostId ?? LOCAL_HOST_ID;
    const kind = opts.kind ?? 'pm2';
    const t = this.now();
    let row = this.getBySource(hostId, sourceKey);
    if (!row) {
      const name = this.freeName(hostId, kind === 'container' ? sourceKey.slice(sourceKey.indexOf('/') + 1) : sourceKey);
      const info = this.db
        .prepare(
          `INSERT INTO services (host_id, kind, name, source_key, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(hostId, kind, name, sourceKey, t, t);
      row = this.db.prepare('SELECT * FROM services WHERE id = ?').get(info.lastInsertRowid) as ServiceRow;
      this.put(row);
      this.touched.set(row.id, t);
      return row;
    }
    if (row.is_archived === 1) {
      this.db.prepare('UPDATE services SET is_archived = 0, last_seen_at = ? WHERE id = ?').run(t, row.id);
      row = { ...row, is_archived: 0, last_seen_at: t };
      this.put(row);
      this.touched.set(row.id, t);
    } else if (t - (this.touched.get(row.id) ?? 0) >= TOUCH_EVERY_MS) {
      this.db.prepare('UPDATE services SET last_seen_at = ? WHERE id = ?').run(t, row.id);
      row = { ...row, last_seen_at: t };
      this.put(row);
      this.touched.set(row.id, t);
    }
    return row;
  }

  /** Set on the first valid agent report; never cleared by the monitor. */
  markAgentEnabled(id: number): void {
    const row = this.get(id);
    if (!row || row.agent_enabled === 1) return;
    this.db.prepare('UPDATE services SET agent_enabled = 1 WHERE id = ?').run(id);
    this.put({ ...row, agent_enabled: 1 });
  }

  /** The display name starts as the source name; if that host already uses it, a suffix is added. */
  private freeName(hostId: number, base: string): string {
    const taken = new Set(this.list(true, hostId).map((r) => r.name.toLowerCase()));
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
    if (patch.isArchived === true && livePm2Names.has(row.source_key)) {
      // Archiving something PM2 (or the host's agent) still lists would be undone by the next
      // discovery cycle. The caller passes the live keys of the service's own host.
      throw new ServiceConflictError('service_active');
    }
    if (patch.name !== undefined) {
      const clash = this.list(true, row.host_id).find(
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
    this.put(updated);
    return updated;
  }

  toDto(r: ServiceRow): ServiceDto {
    const staleMs = this.staleHours() * 3_600_000;
    return {
      id: r.id,
      hostId: r.host_id,
      kind: r.kind,
      sourceKey: r.source_key,
      name: r.name,
      pm2Name: r.source_key,
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
