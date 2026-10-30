import type { FastifyInstance } from 'fastify';
import {
  LOCAL_HOST_ID,
  serviceActionSchema,
  servicePatchSchema,
  spanLabel,
  type ServiceActionResponse,
  type GitResponse,
  type ProcessEventDto,
  type ServiceDetailResponse,
  type ServicesResponse,
  type TenantHistoryResponse,
  type TenantsResponse,
} from '@cc/shared';
import type { AppContext } from '../context';
import { requireUser } from '../guard';
import { ActionError } from '../pm2/actions';
import { fill, gridTimes, makeGrid, parseRange } from '../history';
import { rangeLimits } from '../limits';
import { liveNames } from '../pm2/collector';
import { ServiceConflictError } from '../pm2/services';

const EVENTS_SHOWN = 50;
const MAX_POINTS = 600;

function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function serviceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const user = { preHandler: requireUser(ctx) };
  const admin = { preHandler: requireUser(ctx, { admin: true }) };
  const operate = { preHandler: requireUser(ctx, { operate: true }) };

  app.get('/services', user, async (req, reply): Promise<ServicesResponse | void> => {
    const q = req.query as { archived?: string; host?: string };
    const includeArchived = q.archived === '1';
    // Host 1 by default, so the pages and scripts that predate phase 11 see what they saw before.
    const host = q.host === undefined ? LOCAL_HOST_ID : q.host === 'all' ? 'all' : parseId(q.host);
    if (host === null) return reply.code(400).send({ error: 'invalid_host' });
    return {
      services: ctx.services.list(includeArchived, host).map((r) => ({
        ...ctx.services.toDto(r),
        process: ctx.state.getProcessState(r.id),
        git: r.git_repo ? ctx.git.badge(r.id) : null,
      })),
    };
  });

  app.get('/services/:id', user, async (req, reply): Promise<ServiceDetailResponse | void> => {
    const id = parseId((req.params as { id: string }).id);
    const row = id === null ? undefined : ctx.services.get(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const events = (
      ctx.db
        .prepare('SELECT id, ts, pm_id, event, detail FROM process_events WHERE service_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
        .all(row.id, EVENTS_SHOWN) as { id: number; ts: number; pm_id: number | null; event: string; detail: string | null }[]
    ).map(
      (e): ProcessEventDto => ({
        id: e.id,
        ts: e.ts,
        pm: e.pm_id,
        event: e.event,
        detail: e.detail ? (JSON.parse(e.detail) as unknown) : null,
      }),
    );
    const nginx = ctx.state.getNginx(ctx.now());
    return {
      service: ctx.services.toDto(row),
      traffic: nginx
        ? {
            now: nginx.perService.find((x) => x.serviceId === row.id) ?? null,
            series: ctx.state.getNginxServiceSeries(row.id),
          }
        : null,
      app: ctx.state.app.get(row.id, ctx.now()),
      appSeries: ctx.state.app.series(row.id),
      process: ctx.state.getProcessState(row.id),
      series: ctx.state.getServiceSeries(row.id),
      events,
      openIncidents: ctx.alertRepo.firing().filter((i) => i.service_id === row.id).length,
      git: row.git_repo ? ctx.git.badge(row.id) : null,
      operable: (() => {
        const reason = ctx.actions.blockedReason(row, null);
        return { ok: reason === null, reason };
      })(),
    };
  });

  // Start, stop and restart. Admins, and engineers an admin has allowed. One action at a time per service.
  app.post(
    '/services/:id/actions',
    { ...operate, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply): Promise<ServiceActionResponse | void> => {
      const actor = req.auth!.user;
      const id = parseId((req.params as { id: string }).id);
      const row = id === null ? undefined : ctx.services.get(id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const { action } = serviceActionSchema.parse(req.body);
      try {
        return await ctx.actions.run(row, action, { id: actor.id, username: actor.username, ip: req.ip, userAgent: req.headers['user-agent'] });
      } catch (e) {
        if (e instanceof ActionError) return reply.code(e.status).send({ error: e.code, message: e.message });
        throw e;
      }
    },
  );

  // Code and deploy status from GitHub (read-only). Any signed-in user may see it.
  app.get('/services/:id/git', user, async (req, reply): Promise<GitResponse | void> => {
    const id = parseId((req.params as { id: string }).id);
    const row = id === null ? undefined : ctx.services.get(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { configured: Boolean(row.git_repo), tokenSet: ctx.git.tokenSet, git: row.git_repo ? ctx.git.get(row.id) : null };
  });

  // "Check now". Admin only, and limited so it cannot be used to exhaust the GitHub rate limit.
  app.post('/services/:id/git/refresh', { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply): Promise<GitResponse | void> => {
    const id = parseId((req.params as { id: string }).id);
    const row = id === null ? undefined : ctx.services.get(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const git = row.git_repo ? await ctx.git.check(row) : null;
    return { configured: Boolean(row.git_repo), tokenSet: ctx.git.tokenSet, git };
  });

  // Current tenants of one service, from the agent's latest reports (names added from the tenants table).
  app.get('/services/:id/tenants', user, async (req, reply): Promise<TenantsResponse | void> => {
    const id = parseId((req.params as { id: string }).id);
    const row = id === null ? undefined : ctx.services.get(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const a = ctx.state.app.get(row.id, ctx.now());
    const names = new Map(
      (ctx.db.prepare('SELECT tenant_key, display_name FROM tenants WHERE display_name IS NOT NULL').all() as {
        tenant_key: string;
        display_name: string;
      }[]).map((t) => [t.tenant_key, t.display_name]),
    );
    return {
      serviceId: row.id,
      updatedAt: a?.updatedAt ?? null,
      tenants: (a?.tenants ?? []).map((t) => ({ ...t, displayName: names.get(t.key) ?? null })),
      truncated: a?.tenantsTruncated ?? false,
    };
  });

  // One tenant over time, from the stored 60 s rows. `from` and `to` are epoch milliseconds.
  app.get('/services/:id/tenants/history', user, async (req, reply): Promise<TenantHistoryResponse | void> => {
    const id = parseId((req.params as { id: string }).id);
    const row = id === null ? undefined : ctx.services.get(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const q = req.query as { key?: string; from?: string; to?: string };
    if (!q.key || q.key.length > 100) return reply.code(400).send({ error: 'invalid_request', message: 'key is required.' });
    const maxMs = rangeLimits(ctx.settings).historyMaxMs;
    const range = parseRange(q, ctx.now(), maxMs, 24 * 3_600_000);
    if (!range) return reply.code(400).send({ error: 'invalid_request', message: `The range must be positive and at most ${spanLabel(maxMs)}.` });
    const rows = ctx.db
      .prepare(
        `SELECT m.ts, m.sockets, m.active_users, m.req_per_s, m.p95_ms
         FROM metrics_app_tenant m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.service_id = ? AND t.tenant_key = ? AND m.res_s = 60 AND m.ts >= ? AND m.ts < ?
         ORDER BY m.ts`,
      )
      .all(row.id, q.key, range.from, range.to) as { ts: number; sockets: number; active_users: number; req_per_s: number; p95_ms: number }[];
    const grid = makeGrid(range.from, range.to, MAX_POINTS);
    const s = fill(grid, rows, (x) => x.ts, {
      sockets: { pick: (x) => x.sockets, agg: 'avg' as const },
      activeUsers: { pick: (x) => x.active_users, agg: 'avg' as const },
      reqPerS: { pick: (x) => x.req_per_s, agg: 'avg' as const },
      p95Ms: { pick: (x) => x.p95_ms, agg: 'max' as const },
    });
    return { serviceId: row.id, key: q.key, ts: gridTimes(grid), ...s } as unknown as TenantHistoryResponse;
  });

  app.patch('/services/:id', admin, async (req, reply) => {
    const actor = req.auth!.user;
    const id = parseId((req.params as { id: string }).id);
    const before = id === null ? undefined : ctx.services.get(id);
    if (!before) return reply.code(404).send({ error: 'not_found' });
    const patch = servicePatchSchema.parse(req.body);
    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ error: 'invalid_request', message: 'Nothing to change.' });
    }
    try {
      const after = ctx.services.update(before.id, patch, liveNames(ctx.state.getProcessStates(before.host_id)));
      if (patch.isArchived === true) ctx.alerts.onServiceArchived(before.id);
      if (patch.gitRepo !== undefined || patch.gitBranch !== undefined || patch.gitPath !== undefined) ctx.git.forget(before.id);
      ctx.audit.write({
        event: 'service_updated',
        userId: actor.id,
        username: actor.username,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        detail: { serviceId: before.id, pm2Name: before.source_key, changed: Object.keys(patch) },
      });
      return { service: ctx.services.toDto(after) };
    } catch (e) {
      if (e instanceof ServiceConflictError) return reply.code(409).send({ error: e.code });
      throw e;
    }
  });
}
