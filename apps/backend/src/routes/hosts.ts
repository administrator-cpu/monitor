import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  createHostSchema,
  updateHostSchema,
  type EnrollTokenResponse,
  type HostDto,
  type HostsResponse,
} from '@cc/shared';
import type { AppContext } from '../context';
import { requireUser } from '../guard';
import { HostConflictError, type HostRow } from '../hosts/repo';

const idParam = z.object({ id: z.coerce.number().int().positive() });

const CONFLICT_MESSAGE: Record<HostConflictError['code'], string> = {
  name_taken: 'Another host already has that name.',
  local_host: 'This server (host 1) is monitored directly and has no agent.',
  revoked: 'The host is revoked.',
};

/**
 * Hosts admin API (phase 11, M1). Listing is open to every signed-in user; creating, renaming,
 * issuing enrollment tokens and revoking are for admins. A token is returned exactly once.
 */
export function hostRoutes(app: FastifyInstance, ctx: AppContext): void {
  const user = { preHandler: requireUser(ctx) };
  const admin = { preHandler: requireUser(ctx, { admin: true }) };

  const dto = (r: HostRow): HostDto => {
    const slice = ctx.state.host(r.id);
    const h = slice?.getHost() ?? null;
    return ctx.hosts.toDto(
      r,
      h
        ? {
            at: h.updatedAt,
            cpuPct: h.cpuPct,
            memUsedBytes: h.memUsedBytes,
            memTotalBytes: h.memTotalBytes,
            disks: h.disks.length,
            containers: slice?.getContainersAt()?.list.length ?? 0,
          }
        : null,
    );
  };
  const who = (req: {
    auth?: { user: { id: number; username: string } };
    ip: string;
    headers: { 'user-agent'?: string };
  }) => ({
    userId: req.auth!.user.id,
    username: req.auth!.user.username,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  const conflict = (reply: FastifyReply, e: HostConflictError) =>
    reply
      .code(e.code === 'name_taken' ? 409 : 400)
      .send({ error: e.code, message: CONFLICT_MESSAGE[e.code] });

  app.get('/hosts', user, async (): Promise<HostsResponse> => ({
    hosts: ctx.hosts.list().map(dto),
  }));

  app.post('/hosts', admin, async (req, reply): Promise<EnrollTokenResponse | void> => {
    const body = createHostSchema.parse(req.body);
    try {
      const { host, token } = ctx.hosts.create(
        { name: body.name, os: body.os, notes: body.notes ?? null, createdBy: req.auth!.user.id },
        ctx.settings.get('hosts.enroll_minutes'),
      );
      ctx.audit.write({
        event: 'host_created',
        ...who(req),
        detail: { hostId: host.id, hostName: host.name, os: host.os },
      });
      return reply
        .code(201)
        .send({ host: dto(host), enrollToken: token, enrollExpiresAt: host.enroll_expires_at! });
    } catch (e) {
      if (e instanceof HostConflictError) return conflict(reply, e);
      throw e;
    }
  });

  app.patch('/hosts/:id', admin, async (req, reply): Promise<{ host: HostDto } | void> => {
    const { id } = idParam.parse(req.params);
    const patch = updateHostSchema.parse(req.body);
    const before = ctx.hosts.get(id);
    if (!before) return reply.code(404).send({ error: 'not_found' });
    try {
      const host = ctx.hosts.update(id, patch);
      ctx.audit.write({
        event: 'host_updated',
        ...who(req),
        detail: {
          hostId: id,
          hostName: host.name,
          changed: Object.keys(patch),
          ...(patch.name !== undefined ? { from: before.name } : {}),
        },
      });
      return { host: dto(host) };
    } catch (e) {
      if (e instanceof HostConflictError) return conflict(reply, e);
      throw e;
    }
  });

  // A new one-time token: for a first enrollment that missed the hour, after a revoke, or to rotate
  // the host token. The current token keeps working until an agent uses the new one.
  app.post(
    '/hosts/:id/enroll-token',
    admin,
    async (req, reply): Promise<EnrollTokenResponse | void> => {
      const { id } = idParam.parse(req.params);
      const before = ctx.hosts.get(id);
      if (!before) return reply.code(404).send({ error: 'not_found' });
      try {
        const { host, token } = ctx.hosts.issueEnrollToken(
          id,
          ctx.settings.get('hosts.enroll_minutes'),
        );
        ctx.audit.write({
          event: 'host_token_rotated',
          ...who(req),
          detail: {
            hostId: id,
            hostName: host.name,
            wasEnrolled: before.token_hash !== null,
            wasRevoked: before.revoked_at !== null,
          },
        });
        return { host: dto(host), enrollToken: token, enrollExpiresAt: host.enroll_expires_at! };
      } catch (e) {
        if (e instanceof HostConflictError) return conflict(reply, e);
        throw e;
      }
    },
  );

  // Revoking stops every request from that host's agent at once (401) and removes it from the live
  // view. Its stored history and incidents stay; open incidents end without an email.
  app.post('/hosts/:id/revoke', admin, async (req, reply): Promise<{ host: HostDto } | void> => {
    const { id } = idParam.parse(req.params);
    if (!ctx.hosts.get(id)) return reply.code(404).send({ error: 'not_found' });
    try {
      const host = ctx.hosts.revoke(id);
      ctx.state.dropHost(id);
      ctx.containers.dropHost(id);
      ctx.alerts.onHostRevoked(id);
      ctx.audit.write({
        event: 'host_revoked',
        ...who(req),
        detail: { hostId: id, hostName: host.name },
      });
      return { host: dto(host) };
    } catch (e) {
      if (e instanceof HostConflictError) return conflict(reply, e);
      throw e;
    }
  });
}
