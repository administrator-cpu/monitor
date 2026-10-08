import type { FastifyInstance } from 'fastify';
import type { MongoResponse, MongoSlowQueryDto } from '@cc/shared';
import type { AppContext } from '../context';
import { requireUser } from '../guard';

interface SlowRow {
  id: number;
  ts: number;
  namespace: string;
  op: string | null;
  millis: number;
  plan_summary: string | null;
  docs_examined: number | null;
  keys_examined: number | null;
  n_returned: number | null;
  app_name: string | null;
  command_shape: string | null;
}

const toDto = (r: SlowRow): MongoSlowQueryDto => ({
  id: r.id,
  ts: r.ts,
  namespace: r.namespace,
  op: r.op,
  millis: r.millis,
  planSummary: r.plan_summary,
  docsExamined: r.docs_examined,
  keysExamined: r.keys_examined,
  nReturned: r.n_returned,
  appName: r.app_name,
  commandShape: r.command_shape,
});

export function mongoRoutes(app: FastifyInstance, ctx: AppContext): void {
  const user = { preHandler: requireUser(ctx) };

  const slow = (limit: number, before?: number): MongoSlowQueryDto[] =>
    (
      ctx.db
        .prepare(
          `SELECT * FROM mongo_slow_queries ${before !== undefined ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`,
        )
        .all(...(before !== undefined ? [before, limit] : [limit])) as SlowRow[]
    ).map(toDto);

  app.get('/mongo', user, async (): Promise<MongoResponse> => ({
    mongo: ctx.state.getMongo(),
    configured: Boolean(ctx.config.mongoUri),
    profileDbs: ctx.config.mongoProfileDbs,
    series: ctx.state.getMongoSeries(),
    slowQueries: slow(25),
    collectors: ctx.scheduler.status().filter((c) => c.name === 'mongo'),
  }));

  app.get('/mongo/slow-queries', user, async (req) => {
    const q = req.query as { limit?: string; before?: string };
    const limit = Math.min(200, Math.max(1, Number.parseInt(q.limit ?? '50', 10) || 50));
    const before = q.before !== undefined && /^\d+$/.test(q.before) ? Number(q.before) : undefined;
    return { slowQueries: slow(limit, before) };
  });
}
