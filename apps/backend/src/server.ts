import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { API_PREFIX, CSRF_HEADER, CSRF_VALUE, WS_CLOSE } from '@cc/shared';
import type { AppContext } from './context';
import { MAX_CONNECTIONS_PER_USER } from './hub';
import { adminRoutes } from './routes/admin';
import { alertRoutes } from './routes/alerts';
import { authRoutes } from './routes/auth';
import { monitorRoutes } from './routes/monitor';
import { emailRoutes } from './routes/email';
import { eventRoutes } from './routes/events';
import { historyRoutes } from './routes/history';
import { logSearchRoutes } from './routes/logsearch';
import { mongoRoutes } from './routes/mongo';
import { nginxRoutes } from './routes/nginx';
import { serviceRoutes } from './routes/services';
import { userRoutes } from './routes/users';
import { webhookRoutes } from './routes/webhooks';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const WS_PATH = `${API_PREFIX}/ws`;

/**
 * Structural check rather than `instanceof`: the shared schemas and this file can
 * end up with separate copies of zod (CJS vs ESM loaders), which breaks class identity.
 */
function isZodError(e: unknown): e is { issues: { path: (string | number)[]; message: string }[] } {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: string }).name === 'ZodError' &&
    Array.isArray((e as { issues?: unknown }).issues)
  );
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const allowed = new Set(ctx.config.allowedOrigins);

  const app = Fastify({
    loggerInstance: ctx.log as FastifyBaseLogger,
    // X-Forwarded-For is honoured only when the hop is Nginx on this machine.
    trustProxy: ['127.0.0.1', '::1'],
    bodyLimit: 64 * 1024,
    // The watchdog pings /health every 5 minutes; keep that out of the request log.
    logController: new LogController({ disableRequestLogging: (req) => req.url === '/health' }),
  });

  await app.register(helmet, { crossOriginResourcePolicy: { policy: 'same-site' } });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Monitor-Client'],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 1_048_576 } });

  // CSRF and Origin policy for the API (TRD section 5).
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith(API_PREFIX) || req.method === 'OPTIONS') return;
    // The WebSocket handler enforces the Origin itself so it can answer with close code 4403.
    if (req.url.split('?')[0] === WS_PATH) return;
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) {
      return reply.code(403).send({ error: 'origin_not_allowed' });
    }
    if (STATE_CHANGING.has(req.method) && req.headers[CSRF_HEADER] !== CSRF_VALUE) {
      return reply.code(403).send({ error: 'csrf_header_required' });
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith(API_PREFIX)) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (isZodError(err)) {
      return reply.code(400).send({
        error: 'invalid_request',
        issues: err.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply
        .code(err.statusCode)
        .send({
          error: err.statusCode === 429 ? 'rate_limited' : (err.code ?? 'bad_request'),
          message: err.message,
        });
    }
    req.log.error({ err: { message: err.message, stack: err.stack } }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

  // Shallow, unauthenticated, rate limited: used by the external watchdog (TRD section 4.7).
  app.get('/health', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async () => ({
    status: 'ok',
  }));

  webhookRoutes(app, ctx);

  await app.register(
    async (api) => {
      authRoutes(api, ctx);
      userRoutes(api, ctx);
      adminRoutes(api, ctx);
      monitorRoutes(api, ctx);
      serviceRoutes(api, ctx);
      alertRoutes(api, ctx);
      emailRoutes(api, ctx);
      nginxRoutes(api, ctx);
      mongoRoutes(api, ctx);
      historyRoutes(api, ctx);
      eventRoutes(api, ctx);
      logSearchRoutes(api, ctx);

      api.get('/ws', { websocket: true }, (socket, req) => {
        const origin = req.headers.origin;
        if (!origin || !allowed.has(origin)) {
          socket.close(WS_CLOSE.ORIGIN_NOT_ALLOWED, 'origin not allowed');
          return;
        }
        const token = req.cookies?.[ctx.config.cookieName];
        const r = token ? ctx.sessions.validate(token) : null;
        if (!token || !r || !r.ok || r.user.must_change_password === 1) {
          socket.close(WS_CLOSE.UNAUTHENTICATED, 'unauthenticated');
          return;
        }
        if (ctx.hub.countForUser(r.user.id) >= MAX_CONNECTIONS_PER_USER) {
          socket.close(WS_CLOSE.TOO_MANY_CONNECTIONS, 'too many connections');
          return;
        }
        ctx.hub.attach(socket, r.user.id, token, r.user.username);
      });
    },
    { prefix: API_PREFIX },
  );

  return app;
}
