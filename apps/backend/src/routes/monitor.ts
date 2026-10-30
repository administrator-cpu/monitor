import type { FastifyInstance } from 'fastify';
import {
  LOCAL_HOST_ID,
  type HostAgentInfo,
  type HostResponse,
  type OverviewResponse,
  type OverviewSummary,
  type RangeLimitsResponse,
} from '@cc/shared';
import type { AppContext } from '../context';
import { requireUser } from '../guard';
import { rangeLimits } from '../limits';
import { buildOverviewSummary } from '../summary';

export function monitorRoutes(app: FastifyInstance, ctx: AppContext): void {
  const user = { preHandler: requireUser(ctx) };

  app.get('/overview', user, async (): Promise<OverviewResponse> => ({
    host: ctx.state.getHost(),
    nginx: ctx.state.getNginx(ctx.now()),
    mongo: ctx.state.getMongo(),
    services: ctx.state.getProcessStates().map((process) => ({ process, app: null })),
    collectors: ctx.scheduler.status(),
    logs: ctx.logs.status(),
    openIncidents: ctx.alerts.openCount(),
  }));

  // Alerts by severity, last backup, nearest certificate, GitHub and email; the page polls it every 30 s.
  app.get('/overview/summary', user, async (): Promise<OverviewSummary> => buildOverviewSummary(ctx));

  // The longest history and log search ranges, so the range pickers offer nothing the server would refuse.
  app.get('/limits', user, async (): Promise<RangeLimitsResponse> => rangeLimits(ctx.settings));

  // The series comes from the in-memory ring buffer so a freshly opened page is never empty.
  // `?host=<id>` reads an agent host (phase 11); without it, this server as before.
  app.get('/host', user, async (req, reply): Promise<HostResponse | void> => {
    const raw = (req.query as { host?: string }).host;
    const hostId = raw === undefined ? LOCAL_HOST_ID : Number(raw);
    const row = Number.isInteger(hostId) ? ctx.hosts.get(hostId) : undefined;
    if (!row || row.revoked_at !== null) return reply.code(404).send({ error: 'not_found' });
    if (hostId === LOCAL_HOST_ID) {
      return {
        hostId,
        host: ctx.state.getHost(),
        series: ctx.state.getHostSeries(),
        collectors: ctx.scheduler.status(),
        monitor: ctx.health.snapshot(),
        agent: null,
      };
    }
    const slice = ctx.state.host(hostId);
    const reported = slice?.getAgentInfo() ?? null;
    const agent: HostAgentInfo = {
      version: row.agent_version,
      lastSeenAt: ctx.hosts.lastSeenAt(hostId),
      actionsEnabled: row.actions_enabled === null ? null : row.actions_enabled === 1,
      reportedAt: reported?.at ?? null,
      droppedLogLines: reported?.info.droppedLogLines ?? 0,
      bufferBytes: reported?.info.bufferBytes ?? 0,
      collectors: reported?.info.collectors ?? [],
    };
    return {
      hostId,
      host: slice?.getHost() ?? null,
      series: slice?.getHostSeries() ?? { ts: [], cpuPct: [], memPct: [], netRxBps: [], netTxBps: [] },
      collectors: [],
      monitor: ctx.health.snapshot(),
      agent,
    };
  });
}
