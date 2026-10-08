import type { FastifyInstance } from 'fastify';
import type { WindowsEventDto, WindowsEventsResponse } from '@cc/shared';
import type { AppContext } from '../context';
import { requireUser } from '../guard';

interface Row {
  id: number;
  log_name: string;
  record_id: number;
  ts: number;
  level: 'critical' | 'error' | 'warning';
  provider: string | null;
  event_id: number | null;
  message: string | null;
}

export function eventRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/events/windows', { preHandler: requireUser(ctx) }, async (req): Promise<WindowsEventsResponse> => {
    const q = req.query as { level?: string; limit?: string; before?: string };
    const limit = Math.min(200, Math.max(1, Number.isInteger(Number(q.limit)) && q.limit ? Number(q.limit) : 50));
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.level === 'critical' || q.level === 'error' || q.level === 'warning') {
      where.push('level = ?');
      args.push(q.level);
    }
    if (q.before && Number.isInteger(Number(q.before))) {
      where.push('id < ?');
      args.push(Number(q.before));
    }
    args.push(limit);
    const rows = ctx.db
      .prepare(`SELECT * FROM windows_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
      .all(...args) as Row[];
    return {
      collecting: ctx.state.getEventLog() !== null,
      events: rows.map(
        (r): WindowsEventDto => ({
          id: r.id, logName: r.log_name, recordId: r.record_id, ts: r.ts, level: r.level,
          provider: r.provider, eventId: r.event_id, message: r.message,
        }),
      ),
    };
  });
}
