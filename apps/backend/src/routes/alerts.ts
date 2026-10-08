import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  incidentsQuerySchema,
  muteCreateSchema,
  ruleUpdateSchema,
  subscriptionsPutSchema,
  type AlertStatusResponse,
  type IncidentDetailResponse,
  type TestEmailResponse,
} from '@cc/shared';
import type { AppContext } from '../context';
import { toIncidentDto, toMuteDto, toNotificationDto, toRuleDto } from '../alerts/dto';
import { requireUser } from '../guard';

const MAX_MUTE_MS = 30 * 24 * 3_600_000;

function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function alertRoutes(app: FastifyInstance, ctx: AppContext): void {
  const user = { preHandler: requireUser(ctx) };
  const admin = { preHandler: requireUser(ctx, { admin: true }) };
  const audit = (req: { ip: string; headers: Record<string, unknown> }, actor: { id: number; username: string }) => ({
    userId: actor.id,
    username: actor.username,
    ip: req.ip,
    userAgent: req.headers['user-agent'] as string | undefined,
  });

  app.get('/alerts/incidents', user, async (req) => {
    const q = incidentsQuerySchema.parse(req.query);
    return { incidents: ctx.alertRepo.listIncidents(q).map(toIncidentDto) };
  });

  app.get('/alerts/incidents/:id', user, async (req, reply): Promise<IncidentDetailResponse | void> => {
    const id = parseId((req.params as { id: string }).id);
    const inc = id === null ? undefined : ctx.alertRepo.getIncident(id);
    if (!inc) return reply.code(404).send({ error: 'not_found' });
    const isAdmin = req.auth!.user.role === 'admin';
    return {
      incident: toIncidentDto(inc),
      notifications: isAdmin ? ctx.alertRepo.notificationsFor(inc.id).map((n) => toNotificationDto(n, true)) : [],
    };
  });

  app.get('/alerts/rules', user, async () => ({ rules: ctx.alertRepo.listRules().map(toRuleDto) }));

  app.patch('/alerts/rules/:id', admin, async (req, reply) => {
    const actor = req.auth!.user;
    const id = parseId((req.params as { id: string }).id);
    const before = id === null ? undefined : ctx.alertRepo.getRule(id);
    if (!before) return reply.code(404).send({ error: 'not_found' });
    const patch = ruleUpdateSchema.parse(req.body);
    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ error: 'invalid_request', message: 'Nothing to change.' });
    }
    const dto = toRuleDto(before);
    if (patch.threshold !== undefined && before.threshold === null) {
      return reply.code(400).send({ error: 'invalid_request', message: 'This rule has no threshold.' });
    }
    if (patch.overrides !== undefined && !dto.perService) {
      return reply.code(400).send({ error: 'invalid_request', message: 'Overrides apply to per-service rules only.' });
    }
    const after = ctx.alertRepo.updateRule(before.id, patch, actor.id);
    ctx.audit.write({
      event: 'alert_rule_changed',
      ...audit(req, actor),
      detail: { rule: before.key, before: dto, after: toRuleDto(after) },
    });
    return { rule: toRuleDto(after) };
  });

  const names = {
    service: (id: number) => ctx.services.get(id)?.name ?? null,
    rule: (id: number) => ctx.alertRepo.getRule(id)?.name ?? null,
  };

  app.get('/alerts/mutes', user, async () => {
    const now = ctx.now();
    return { mutes: ctx.alertRepo.listMutes().map((m) => toMuteDto(m, names, now)) };
  });

  app.post('/alerts/mutes', admin, async (req, reply) => {
    const actor = req.auth!.user;
    const b = muteCreateSchema.parse(req.body);
    const now = ctx.now();
    const startsAt = b.startsAt ?? now;
    if (b.endsAt <= startsAt || b.endsAt <= now) {
      return reply.code(400).send({ error: 'invalid_request', message: 'The mute must end in the future, after it starts.' });
    }
    if (b.endsAt - startsAt > MAX_MUTE_MS) {
      return reply.code(400).send({ error: 'invalid_request', message: 'A mute can last at most 30 days.' });
    }
    if (b.serviceId && !ctx.services.get(b.serviceId)) {
      return reply.code(400).send({ error: 'invalid_request', message: 'Unknown service.' });
    }
    if (b.ruleId && !ctx.alertRepo.getRule(b.ruleId)) {
      return reply.code(400).send({ error: 'invalid_request', message: 'Unknown rule.' });
    }
    const m = ctx.alertRepo.insertMute({
      starts_at: startsAt,
      ends_at: b.endsAt,
      service_id: b.serviceId ?? null,
      category: b.category ?? null,
      rule_id: b.ruleId ?? null,
      reason: b.reason ?? null,
      created_by: actor.id,
    });
    ctx.audit.write({ event: 'alert_mute_created', ...audit(req, actor), detail: { muteId: m.id, ...b } });
    return reply.code(201).send({ mute: toMuteDto(m, names, now) });
  });

  app.delete('/alerts/mutes/:id', admin, async (req, reply) => {
    const actor = req.auth!.user;
    const id = parseId((req.params as { id: string }).id);
    const m = id === null ? undefined : ctx.alertRepo.getMute(id);
    if (!m) return reply.code(404).send({ error: 'not_found' });
    ctx.alertRepo.deleteMute(m.id);
    ctx.audit.write({ event: 'alert_mute_deleted', ...audit(req, actor), detail: { muteId: m.id } });
    return reply.code(204).send();
  });

  app.get('/alerts/subscriptions/me', user, async (req) => ({
    categories: ctx.alertRepo.getSubscriptions(req.auth!.user.id),
    /** Admins always receive every category. */
    allCategories: req.auth!.user.role === 'admin',
  }));

  app.put('/alerts/subscriptions/me', user, async (req) => {
    const b = subscriptionsPutSchema.parse(req.body);
    ctx.alertRepo.putSubscriptions(req.auth!.user.id, b.categories);
    return { categories: ctx.alertRepo.getSubscriptions(req.auth!.user.id), allCategories: req.auth!.user.role === 'admin' };
  });

  app.get('/alerts/status', user, async (req): Promise<AlertStatusResponse> => {
    const email = ctx.notifier.status();
    const isAdmin = req.auth!.user.role === 'admin';
    return {
      email: isAdmin ? email : { ...email, lastError: null, from: null, missing: [] },
      engine: ctx.alerts.status(),
    };
  });

  // Sent only to the calling admin's own address, never to a typed-in one.
  app.post(
    '/alerts/test-email',
    { ...admin, config: { rateLimit: { max: 3, timeWindow: '1 minute' } } },
    async (req): Promise<TestEmailResponse> => {
      const actor = req.auth!.user;
      const r = await ctx.notifier.sendTest(actor.email, `test-${randomUUID()}`);
      ctx.audit.write({ event: 'test_email_sent', ...audit(req, actor), detail: { status: r.status } });
      return r;
    },
  );
}
