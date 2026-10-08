import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createUserSchema, resetPasswordSchema, updateUserSchema } from '@cc/shared';
import { hashPassword, passwordPolicyError } from '../auth/password';
import { DuplicateUserError, toUserDto } from '../auth/users';
import type { AppContext } from '../context';
import { requireUser } from '../guard';

const idParam = z.object({ id: z.coerce.number().int().positive() });

export function userRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { preHandler: requireUser(ctx, { admin: true }) };

  app.get('/users', admin, async () => ({ users: ctx.users.list().map(toUserDto) }));

  app.post('/users', admin, async (req, reply) => {
    const actor = req.auth!.user;
    const body = createUserSchema.parse(req.body);
    const problem = passwordPolicyError(body.password, { username: body.username });
    if (problem) return reply.code(400).send({ error: 'weak_password', message: problem });

    try {
      const { password, ...rest } = body;
      const row = ctx.users.create({ ...rest, passwordHash: await hashPassword(password) });
      ctx.audit.write({
        event: 'user_created',
        userId: actor.id,
        username: actor.username,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        detail: { targetUserId: row.id, targetUsername: row.username, role: row.role },
      });
      return reply.code(201).send({ user: toUserDto(row) });
    } catch (e) {
      if (e instanceof DuplicateUserError) {
        return reply
          .code(409)
          .send({ error: `${e.field}_taken`, message: `That ${e.field} is already in use.` });
      }
      throw e;
    }
  });

  app.patch('/users/:id', admin, async (req, reply) => {
    const actor = req.auth!.user;
    const { id } = idParam.parse(req.params);
    const patch = updateUserSchema.parse(req.body);
    const target = ctx.users.getById(id);
    if (!target) return reply.code(404).send({ error: 'not_found' });

    const demoting = patch.role !== undefined && patch.role !== 'admin';
    const disabling = patch.isActive === false;
    if (target.id === actor.id && (demoting || disabling)) {
      return reply.code(400).send({
        error: 'cannot_modify_self',
        message: 'You cannot disable or demote your own account.',
      });
    }
    if (target.role === 'admin' && target.is_active === 1 && (demoting || disabling)) {
      if (ctx.users.countActiveAdmins() <= 1) {
        return reply.code(400).send({
          error: 'last_admin',
          message: 'At least one active admin must remain.',
        });
      }
    }

    let updated;
    try {
      updated = ctx.users.update(id, patch);
    } catch (e) {
      if (e instanceof DuplicateUserError) {
        return reply
          .code(409)
          .send({ error: `${e.field}_taken`, message: `That ${e.field} is already in use.` });
      }
      throw e;
    }

    const who = {
      userId: actor.id,
      username: actor.username,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    };
    const wasActive = target.is_active === 1;
    const nowActive = updated.is_active === 1;
    // Field names only: the audit log records what changed, not personal values.
    const changed = Object.keys(patch).filter(
      (k) => (patch as Record<string, unknown>)[k] !== undefined,
    );
    if (changed.length > 0) {
      ctx.audit.write({
        ...who,
        event: 'user_updated',
        detail: { targetUserId: id, fields: changed },
      });
    }
    if (wasActive && !nowActive) {
      const revoked = ctx.sessions.revokeAllForUser(id);
      ctx.hub.closeUser(id);
      ctx.audit.write({
        ...who,
        event: 'user_disabled',
        detail: { targetUserId: id, sessionsRevoked: revoked },
      });
    } else if (!wasActive && nowActive) {
      ctx.audit.write({ ...who, event: 'user_enabled', detail: { targetUserId: id } });
    }
    return { user: toUserDto(updated) };
  });

  app.post('/users/:id/reset-password', admin, async (req, reply) => {
    const actor = req.auth!.user;
    const { id } = idParam.parse(req.params);
    const body = resetPasswordSchema.parse(req.body);
    const target = ctx.users.getById(id);
    if (!target) return reply.code(404).send({ error: 'not_found' });
    const problem = passwordPolicyError(body.password, { username: target.username });
    if (problem) return reply.code(400).send({ error: 'weak_password', message: problem });

    // Also clears any lockout. The user must choose a new password at next login.
    ctx.users.setPassword(id, await hashPassword(body.password), true);
    const revoked = ctx.sessions.revokeAllForUser(id);
    ctx.hub.closeUser(id);
    ctx.audit.write({
      event: 'password_reset',
      userId: actor.id,
      username: actor.username,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      detail: { targetUserId: id, sessionsRevoked: revoked },
    });
    return reply.code(204).send();
  });

  app.post('/users/:id/revoke-sessions', admin, async (req, reply) => {
    const actor = req.auth!.user;
    const { id } = idParam.parse(req.params);
    const target = ctx.users.getById(id);
    if (!target) return reply.code(404).send({ error: 'not_found' });
    const revoked = ctx.sessions.revokeAllForUser(id);
    ctx.hub.closeUser(id);
    ctx.audit.write({
      event: 'session_revoked',
      userId: actor.id,
      username: actor.username,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      detail: { targetUserId: id, sessionsRevoked: revoked },
    });
    return { revoked };
  });
}
