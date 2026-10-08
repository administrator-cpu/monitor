import type { FastifyInstance } from 'fastify';
import type { NginxResponse, TlsCertDto } from '@cc/shared';
import type { AppContext } from '../context';
import { requireUser } from '../guard';

const DAY_MS = 86_400_000;

export function toCertDto(r: { host: string; notAfter: number | null; issuer: string | null; checkedAt: number; lastError: string | null }, now: number): TlsCertDto {
  return {
    host: r.host,
    notAfter: r.notAfter,
    issuer: r.issuer,
    checkedAt: r.checkedAt,
    lastError: r.lastError,
    daysLeft: r.notAfter === null ? null : Math.floor((r.notAfter - now) / DAY_MS),
  };
}

export function nginxRoutes(app: FastifyInstance, ctx: AppContext): void {
  const user = { preHandler: requireUser(ctx) };

  app.get('/nginx', user, async (): Promise<NginxResponse> => {
    const now = ctx.now();
    return {
      nginx: ctx.state.getNginx(now),
      configured: {
        status: Boolean(ctx.config.nginxStatusUrl),
        accessLog: Boolean(ctx.config.nginxAccessLog),
        tls: ctx.config.tlsCheckHosts.length > 0 || ctx.services.list(false).some((s) => s.public_url?.startsWith('https:')),
      },
      series: ctx.state.getNginxSeries(),
      certs: ctx.state.getTlsCerts().map((c) => toCertDto(c, now)),
      collectors: ctx.scheduler.status().filter((c) => ['nginxstatus', 'nginxlog', 'tls'].includes(c.name)),
    };
  });
}
