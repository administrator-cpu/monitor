import type { FastifyInstance } from 'fastify';
import { Webhook } from 'svix';
import type { AppContext } from '../context';
import { bounceKind, eventOf, senderDomain } from '../email/stats';

/**
 * Resend webhooks (delivery monitoring). Lives outside /api/v1: it has no session, so it must not
 * be reachable through the browser CSRF rules. Trust comes only from the Svix signature over the
 * exact raw body, which is why this plugin keeps the body as text.
 */
export function webhookRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

    scope.post(
      '/webhooks/resend',
      { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const secret = ctx.config.resendWebhookSecret;
        if (!secret) return reply.code(503).send({ error: 'not_configured' });
        const raw = typeof req.body === 'string' ? req.body : '';
        const id = req.headers['svix-id'];
        const ts = req.headers['svix-timestamp'];
        const sig = req.headers['svix-signature'];
        if (typeof id !== 'string' || typeof ts !== 'string' || typeof sig !== 'string' || raw === '') {
          return reply.code(400).send({ error: 'invalid_request' });
        }
        // Svix rejects a timestamp more than 5 minutes from now, which stops old captured requests being replayed.
        let payload: { type?: unknown; created_at?: unknown; data?: { from?: unknown } };
        try {
          // verify() proves the signature over the exact bytes; the body is parsed only after that.
          new Webhook(secret).verify(raw, { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig });
          payload = JSON.parse(raw) as typeof payload;
        } catch {
          return reply.code(401).send({ error: 'invalid_signature' });
        }
        const event = eventOf(payload.type);
        if (!event) return { ok: true, ignored: true };
        const at = Date.parse(String(payload.created_at ?? '')) || ctx.now();
        const counted = ctx.email.record(id, event, senderDomain(payload.data?.from), bounceKind(payload.data), at);
        return { ok: true, duplicate: !counted };
      },
    );
  });
}
