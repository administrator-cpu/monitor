import type { FastifyInstance } from 'fastify';
import type { HostResponse, OverviewResponse, RangeLimitsResponse } from '@cc/shared';
import type { AppContext } from '../context';
import { requireUser } from '../guard';
import { rangeLimits } from '../limits';

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

  // The longest history and log search ranges, so the range pickers offer nothing the server would refuse.
  app.get('/limits', user, async (): Promise<RangeLimitsResponse> => rangeLimits(ctx.settings));

  // The series comes from the in-memory ring buffer so a freshly opened page is never empty.
  app.get('/host', user, async (): Promise<HostResponse> => ({
    host: ctx.state.getHost(),
    series: ctx.state.getHostSeries(),
    collectors: ctx.scheduler.status(),
    monitor: ctx.health.snapshot(),
  }));
}
