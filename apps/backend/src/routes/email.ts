import type { FastifyInstance } from 'fastify';
import type { EmailSummaryResponse } from '@cc/shared';
import type { AppContext } from '../context';
import { requireUser } from '../guard';

export function emailRoutes(app: FastifyInstance, ctx: AppContext): void {
  const user = { preHandler: requireUser(ctx) };

  // Delivery counts from Resend webhooks. Counts only; there is nothing per message to show.
  app.get('/email/summary', user, async (req, reply): Promise<EmailSummaryResponse | void> => {
    const raw = Number((req.query as { hours?: string }).hours ?? 24);
    if (!Number.isFinite(raw) || raw < 1 || raw > 720) return reply.code(400).send({ error: 'invalid_request', message: 'hours must be 1 to 720.' });
    const hours = Math.floor(raw);
    const now = ctx.now();
    const from = now - hours * 3_600_000;
    return {
      configured: Boolean(ctx.config.resendWebhookSecret),
      lastReceivedAt: ctx.email.lastReceivedAt(),
      hours,
      from,
      rows: ctx.email.summary(from),
      hourly: ctx.email.hourly(from, now),
      badLastHour: ctx.email.badSince(now - 3_600_000),
    };
  });
}
