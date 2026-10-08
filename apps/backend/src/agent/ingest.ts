import crypto from 'node:crypto';
import http from 'node:http';
import { AGENT_MAX_BODY_BYTES, agentReportSchema } from '@cc/shared';
import type { AppContext } from '../context';

const PATH = '/ingest/v1/agent';

/** Compares digests, so neither the length nor the content of the token leaks through timing. */
export function tokenMatches(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Handles one request. Exposed separately from the listener so tests can drive it without a port.
 * Responses: 204 accepted, 400 invalid or unknown service, 401 bad token, 404/405 wrong route,
 * 413 too large. Bodies are never echoed and the token is never logged.
 */
export function createIngestHandler(ctx: AppContext, token: string): http.RequestListener {
  const lastWarn = new Map<string, number>();
  const warnOnce = (key: string, obj: Record<string, unknown>, msg: string): void => {
    const t = ctx.now();
    if (t - (lastWarn.get(key) ?? 0) < 300_000) return;
    lastWarn.set(key, t);
    ctx.log.warn(obj, msg);
  };
  const reply = (res: http.ServerResponse, code: number, body?: unknown): void => {
    if (res.headersSent) return;
    res.statusCode = code;
    res.setHeader('Connection', 'close');
    if (body === undefined) {
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };

  return (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== PATH) return reply(res, 404, { error: 'not_found' });
    if (req.method !== 'POST') return reply(res, 405, { error: 'method_not_allowed' });
    // The token is checked before any of the body is read.
    if (!tokenMatches(req.headers['x-monitor-token'], token)) {
      warnOnce('auth', {}, 'agent report rejected: bad token');
      req.resume();
      return reply(res, 401, { error: 'unauthorized' });
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > AGENT_MAX_BODY_BYTES) {
      req.resume();
      return reply(res, 413, { error: 'too_large' });
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > AGENT_MAX_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        return;
      }
      if (!over) chunks.push(c);
    });
    req.on('error', () => undefined);
    req.on('end', () => {
      if (over) return reply(res, 413, { error: 'too_large' });
      let json: unknown;
      try {
        json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(res, 400, { error: 'invalid_json' });
      }
      const parsed = agentReportSchema.safeParse(json);
      if (!parsed.success) return reply(res, 400, { error: 'invalid_report' });
      const r = parsed.data;
      let svc = ctx.services.getByPm2Name(r.service);
      // A service is only registered from an agent report when PM2 really lists a process by that name.
      if (!svc && ctx.state.getProcessStates().some((p) => p.pm2Name === r.service)) {
        svc = ctx.services.discover(r.service);
      }
      if (!svc || svc.is_archived === 1) {
        ctx.state.app.rejected += 1;
        warnOnce(`unknown:${r.service}`, { service: r.service.slice(0, 100) }, 'agent report rejected: no PM2 service with this name');
        return reply(res, 400, { error: 'unknown_service' });
      }
      ctx.state.app.ingest(svc.id, r, ctx.now());
      ctx.services.markAgentEnabled(svc.id);
      reply(res, 204);
    });
  };
}

export interface IngestServer {
  server: http.Server;
  close(): Promise<void>;
}

/** Always loopback: agents run on the same machine, and the port is never exposed. */
export async function startIngest(ctx: AppContext, token: string): Promise<IngestServer> {
  const server = http.createServer(createIngestHandler(ctx, token));
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 40;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(ctx.config.portIngest, '127.0.0.1', () => resolve());
  });
  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
