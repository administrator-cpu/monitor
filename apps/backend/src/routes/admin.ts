import type { FastifyInstance } from 'fastify';
import { auditQuerySchema, settingsPatchSchema } from '@cc/shared';
import type { AppContext } from '../context';
import { requireUser } from '../guard';
import { SettingsError } from '../settings';

export function adminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { preHandler: requireUser(ctx, { admin: true }) };

  app.get('/audit', admin, async (req) => {
    const q = auditQuerySchema.parse(req.query);
    return { entries: ctx.audit.list(q) };
  });

  app.get('/settings', admin, async () => ({ settings: ctx.settings.all() }));

  app.patch('/settings', admin, async (req, reply) => {
    const actor = req.auth!.user;
    const patch = settingsPatchSchema.parse(req.body);
    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ error: 'invalid_request', message: 'No settings supplied.' });
    }
    try {
      const changes = ctx.settings.setMany(patch, actor.id);
      ctx.audit.write({
        event: 'settings_changed',
        userId: actor.id,
        username: actor.username,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        detail: { changes },
      });
      return { settings: ctx.settings.all() };
    } catch (e) {
      if (e instanceof SettingsError) {
        return reply.code(400).send({ error: e.code, message: e.message });
      }
      throw e;
    }
  });
}
