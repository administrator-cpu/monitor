import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import {
  AGENT_INGEST_LIMITS,
  AGENT_RATE_GLOBAL,
  AGENT_RATE_PER_HOST,
  AGENT_VERSION_HEADER,
  agentEnrollSchema,
  agentEventsSchema,
  agentLogsSchema,
  agentMetricsSchema,
  agentReportSchema,
  type AgentEndpoint,
} from '@cc/shared';
import type { AppContext } from '../context';
import type { HostRow } from './repo';

/**
 * The agent ingest API (TRD 14.3): public, outside /api/v1, in its own Fastify scope.
 *
 *  - No cookies are read and no CORS headers are given; any request with an `Origin` header is
 *    refused (403), so a browser page can never talk to it.
 *  - Every request except `enroll` needs `Authorization: Bearer <host token>` and `X-Agent-Version`.
 *    The host is taken from the token, never from the body.
 *  - Bodies are JSON, optionally gzip. The size limit is checked on the compressed bytes and again
 *    while inflating, so a small body cannot expand past it (a "gzip bomb" gets 413).
 *  - Schemas are strict: unknown fields are refused (400).
 *  - 600 requests per minute per host and 3000 across all hosts (429 with Retry-After); the enroll
 *    route has its own 10 per minute per address.
 *
 * Responses: 200 or 204 accepted; 400 invalid body; 401 bad, missing or revoked token; 403 Origin
 * present; 413 too large; 415 not JSON or an unknown encoding; 426 agent too old; 429 rate limited.
 */

declare module 'fastify' {
  interface FastifyRequest {
    agentHost?: HostRow;
  }
  interface FastifyContextConfig {
    agentEndpoint?: AgentEndpoint;
  }
}

class IngestError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

/** `1.2.3` → comparable tuple; null when it does not look like a version. */
export function parseVersion(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionBelow(v: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i]! < min[i]!;
  return false;
}

/** Fixed one-minute windows: cheap, and exact enough for a limit far above normal traffic. */
class MinuteCounter {
  private window = 0;
  private counts = new Map<string, number>();
  constructor(private readonly now: () => number) {}
  /** Counts one request; returns the seconds until the window ends when `limit` is exceeded. */
  hit(key: string, limit: number): number | null {
    const t = this.now();
    const w = Math.floor(t / 60_000);
    if (w !== this.window) {
      this.window = w;
      this.counts.clear();
    }
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n > limit ? Math.max(1, Math.ceil(((w + 1) * 60_000 - t) / 1000)) : null;
  }
}

/** Reads the raw body, inflating gzip, and stops at `limit` bytes before or after inflating. */
function readBody(payload: Readable, encoding: string | undefined, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const enc = (encoding ?? 'identity').trim().toLowerCase();
    if (enc !== 'identity' && enc !== 'gzip') {
      payload.resume();
      return reject(
        new IngestError(
          415,
          'unsupported_encoding',
          'Only gzip or no Content-Encoding is accepted.',
        ),
      );
    }
    let raw = 0;
    let out = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      payload.unpipe?.();
      payload.resume();
      reject(e);
    };
    const tooLarge = (): void =>
      fail(new IngestError(413, 'too_large', `The body is larger than ${limit} bytes.`));

    const sink = enc === 'gzip' ? zlib.createGunzip() : null;
    payload.on('data', (c: Buffer) => {
      raw += c.length;
      if (raw > limit) {
        sink?.destroy();
        tooLarge();
      }
    });
    payload.on('error', (e) => fail(e));

    const source: Readable = sink ? payload.pipe(sink) : payload;
    source.on('data', (c: Buffer) => {
      if (settled) return;
      out += c.length;
      if (out > limit) {
        sink?.destroy();
        return tooLarge();
      }
      chunks.push(c);
    });
    if (sink)
      sink.on('error', () =>
        fail(new IngestError(400, 'invalid_gzip', 'The gzip body could not be inflated.')),
      );
    source.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

export function agentIngestRoutes(scope: FastifyInstance, ctx: AppContext): void {
  const perHost = new MinuteCounter(ctx.now);
  const global = new MinuteCounter(ctx.now);
  /** Audit `agent_version_rejected` once per host and version per hour, not every 10 s. */
  const versionAudited = new Map<string, number>();
  let unauthorized = 0;

  const reject = (
    req: FastifyRequest,
    reply: FastifyReply,
    code: number,
    error: string,
    message?: string,
  ): FastifyReply => {
    if (req.agentHost) ctx.hosts.countsOf(req.agentHost.id).rejected += 1;
    return reply.code(code).send(message ? { error, message } : { error });
  };

  // Nothing here is for browsers or for the session API.
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser('*', (req, payload, done) => {
    const type = String(req.headers['content-type'] ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    if (type !== 'application/json') {
      payload.resume();
      return done(
        new IngestError(415, 'unsupported_media_type', 'Send application/json.'),
        undefined,
      );
    }
    const limit = AGENT_INGEST_LIMITS[req.routeOptions.config.agentEndpoint ?? 'enroll'];
    readBody(payload, req.headers['content-encoding'] as string | undefined, limit).then(
      (buf) => {
        try {
          done(null, JSON.parse(buf.toString('utf8')));
        } catch {
          done(new IngestError(400, 'invalid_json'), undefined);
        }
      },
      (e: Error) => done(e, undefined),
    );
  });

  scope.setErrorHandler(
    (
      err: Error & { statusCode?: number; code?: string; issues?: { path: (string | number)[] }[] },
      req,
      reply,
    ) => {
      if (err.name === 'ZodError' && Array.isArray(err.issues)) {
        // Paths only: the agent's values are never echoed back or logged.
        return reject(
          req,
          reply,
          400,
          'invalid_body',
          err.issues
            .slice(0, 5)
            .map((i) => i.path.join('.') || '(root)')
            .join(', '),
        );
      }
      if (err instanceof IngestError || (err.statusCode && err.statusCode < 500)) {
        const code =
          err instanceof IngestError
            ? err.code
            : err.statusCode === 429
              ? 'rate_limited'
              : (err.code ?? 'bad_request');
        return reject(req, reply, err.statusCode ?? 400, code, err.message);
      }
      req.log.error({ err: { message: err.message } }, 'agent ingest failed');
      return reply.code(500).send({ error: 'internal_error' });
    },
  );

  scope.addHook('onRequest', async (req, reply) => {
    if (req.headers.origin !== undefined) return reject(req, reply, 403, 'origin_not_allowed');
    const endpoint = req.routeOptions.config.agentEndpoint;
    if (endpoint === undefined) return; // 404 from the not-found handler

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > AGENT_INGEST_LIMITS[endpoint]) {
      return reject(
        req,
        reply,
        413,
        'too_large',
        `The body is larger than ${AGENT_INGEST_LIMITS[endpoint]} bytes.`,
      );
    }
    if (endpoint === 'enroll') return; // authenticated by its one-time token in the body

    const auth = req.headers.authorization;
    const m = typeof auth === 'string' ? /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(auth) : null;
    const host = m ? ctx.hosts.byBearer(m[1]!) : undefined;
    if (!host) {
      unauthorized += 1;
      if (unauthorized % 100 === 1)
        req.log.warn(
          { count: unauthorized },
          'agent request refused: bad, missing or revoked token',
        );
      return reply.code(401).send({ error: 'unauthorized' });
    }
    req.agentHost = host;

    const version = parseVersion(req.headers[AGENT_VERSION_HEADER]);
    if (!version)
      return reject(req, reply, 400, 'agent_version_required', 'Send X-Agent-Version as 1.2.3.');
    const min = parseVersion(ctx.settings.getString('hosts.min_agent_version'));
    if (min && versionBelow(version, min)) {
      const v = version.join('.');
      const key = `${host.id}:${v}`;
      if (ctx.now() - (versionAudited.get(key) ?? 0) >= 3_600_000) {
        versionAudited.set(key, ctx.now());
        ctx.audit.write({
          event: 'agent_version_rejected',
          username: 'system',
          ip: req.ip,
          detail: {
            hostId: host.id,
            hostName: host.name,
            agentVersion: v,
            minVersion: min.join('.'),
          },
        });
      }
      return reject(
        req,
        reply,
        426,
        'agent_too_old',
        `This monitor needs agent ${min.join('.')} or newer.`,
      );
    }

    const wait =
      perHost.hit(String(host.id), AGENT_RATE_PER_HOST) ?? global.hit('all', AGENT_RATE_GLOBAL);
    if (wait !== null) {
      reply.header('Retry-After', String(wait));
      return reject(req, reply, 429, 'rate_limited');
    }
  });

  const noLimit = { rateLimit: false } as const;
  const touch = (
    req: FastifyRequest,
    extra: { actions?: boolean; skewMs?: number } = {},
  ): boolean =>
    ctx.hosts.touch(req.agentHost!.id, {
      agentVersion: parseVersion(req.headers[AGENT_VERSION_HEADER])!.join('.'),
      ...extra,
    });

  scope.post(
    '/enroll',
    { config: { agentEndpoint: 'enroll', rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = agentEnrollSchema.parse(req.body);
      const version = parseVersion(body.agentVersion)!;
      const min = parseVersion(ctx.settings.getString('hosts.min_agent_version'));
      // Checked before the exchange, so a too-old agent does not use up the one-time token.
      if (min && versionBelow(version, min)) {
        return reply
          .code(426)
          .send({
            error: 'agent_too_old',
            message: `This monitor needs agent ${min.join('.')} or newer.`,
          });
      }
      const r = ctx.hosts.enroll(body.enrollToken, {
        hostname: body.hostname,
        os: body.os,
        agentVersion: body.agentVersion,
      });
      if (!r.ok) {
        req.log.warn({ reason: r.error }, 'agent enrollment refused');
        return reply.code(r.error === 'os_mismatch' ? 400 : 401).send({ error: r.error });
      }
      ctx.audit.write({
        event: 'host_enrolled',
        username: 'system',
        ip: req.ip,
        detail: {
          hostId: r.host.id,
          hostName: r.host.name,
          hostname: body.hostname.slice(0, 100),
          agentVersion: body.agentVersion,
          reEnrolled: r.reEnrolled,
        },
      });
      req.log.info({ host: r.host.name }, 'agent enrolled');
      return reply.code(200).send({ hostId: r.host.id, hostName: r.host.name, token: r.token });
    },
  );

  scope.post(
    '/metrics',
    { config: { agentEndpoint: 'metrics', ...noLimit } },
    async (req, reply) => {
      const body = agentMetricsSchema.parse(req.body);
      const at = ctx.now();
      // The snapshot is taken moments before it is sent, so it is stored at arrival time; the agent's
      // clock is only compared, and reported on the Hosts page when it is more than 5 minutes off.
      touch(req, { actions: body.actions === 'on', skewMs: body.ts - at });
      const id = req.agentHost!.id;
      const slice = ctx.state.ensureHost(id);
      const h = body.host;
      slice.setCpuMem({
        at,
        cpuPct: h.cpuPct,
        cpuPerCore: h.cpuPerCore,
        memUsedBytes: h.memUsedBytes,
        memTotalBytes: h.memTotalBytes,
        swapUsedBytes: h.swapUsedBytes,
        swapTotalBytes: h.swapTotalBytes,
        netRxBps: h.netRxBps,
        netTxBps: h.netTxBps,
      });
      slice.setSystem({ at, uptimeS: h.uptimeS, pendingReboot: h.pendingReboot });
      slice.setDisks(
        h.disks.map((d) => ({
          volume: d.volume,
          usedBytes: d.usedBytes,
          totalBytes: d.totalBytes,
          readBps: d.readBps ?? null,
          writeBps: d.writeBps ?? null,
        })),
        at,
      );
      // Without a `containers` section the agent could not read Docker this time: the services keep
      // their last state and age out of freshness, instead of being reported as stopped.
      if (body.containers) {
        slice.setContainers(body.containers, at);
        ctx.containers.report(id, body.containers, at, body.ts);
      }
      if (body.agent) slice.setAgentInfo(body.agent, at);
      ctx.hosts.countsOf(id).metrics += 1;
      return reply.code(204).send();
    },
  );

  // Container logs (M3): stored per service; the answer tells the agent which services not to
  // follow and its line limit, so a change on a service page reaches it within a second.
  scope.post('/logs', { config: { agentEndpoint: 'logs', ...noLimit } }, async (req, reply) => {
    const body = agentLogsSchema.parse(req.body);
    touch(req);
    ctx.hosts.countsOf(req.agentHost!.id).logs += 1;
    return reply.code(200).send(ctx.remoteLogs.accept(req.agentHost!, body));
  });

  scope.post('/events', { config: { agentEndpoint: 'events', ...noLimit } }, async (req, reply) => {
    const body = agentEventsSchema.parse(req.body);
    touch(req);
    const c = ctx.hosts.countsOf(req.agentHost!.id);
    c.events += 1;
    c.eventCount += body.events.length;
    ctx.containers.events(req.agentHost!.id, body.events);
    return reply.code(204).send();
  });

  scope.post('/app', { config: { agentEndpoint: 'app', ...noLimit } }, async (req, reply) => {
    agentReportSchema.parse(req.body);
    touch(req);
    ctx.hosts.countsOf(req.agentHost!.id).app += 1;
    return reply.code(204).send();
  });
}
