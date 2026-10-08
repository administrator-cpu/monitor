import type { FastifyInstance } from 'fastify';
import { changePasswordSchema, loginSchema, type MeResponse } from '@cc/shared';
import { hashPassword, passwordPolicyError, verifyPassword } from '../auth/password';
import { hashToken } from '../auth/sessions';
import { toUserDto, type UserRow } from '../auth/users';
import type { AppContext } from '../context';
import { clearSessionCookie, requireUser, setSessionCookie } from '../guard';

const me = (user: UserRow, expiresAt: number): MeResponse => ({
  user: toUserDto(user),
  mustChangePassword: user.must_change_password === 1,
  sessionExpiresAt: expiresAt,
});

export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = loginSchema.parse(req.body);
      const result = await ctx.auth.login({
        username: body.username,
        password: body.password,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      if (!result.ok) {
        // Same body for unknown user, wrong password and disabled account.
        return reply
          .code(result.status)
          .send(
            result.error === 'too_many_attempts'
              ? { error: result.error, message: 'Too many attempts. Try again later.' }
              : { error: result.error, message: 'Invalid username or password.' },
          );
      }
      setSessionCookie(ctx, reply, result.token, result.expiresAt);
      return me(result.user, result.expiresAt);
    },
  );

  app.post(
    '/auth/logout',
    { preHandler: requireUser(ctx, { allowMustChange: true }) },
    async (req, reply) => {
      const auth = req.auth!;
      ctx.sessions.revokeByToken(auth.token);
      ctx.audit.write({
        event: 'logout',
        userId: auth.user.id,
        username: auth.user.username,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      clearSessionCookie(ctx, reply);
      return reply.code(204).send();
    },
  );

  app.get('/auth/me', { preHandler: requireUser(ctx, { allowMustChange: true }) }, async (req) => {
    const auth = req.auth!;
    return me(auth.user, auth.session.expires_at);
  });

  app.post(
    '/auth/change-password',
    {
      preHandler: requireUser(ctx, { allowMustChange: true }),
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const auth = req.auth!;
      const body = changePasswordSchema.parse(req.body);

      if (!(await verifyPassword(body.currentPassword, auth.user.password_hash))) {
        return reply.code(400).send({
          error: 'invalid_current_password',
          message: 'The current password is incorrect.',
        });
      }
      if (body.newPassword === body.currentPassword) {
        return reply.code(400).send({
          error: 'same_password',
          message: 'The new password must differ from the current one.',
        });
      }
      const problem = passwordPolicyError(body.newPassword, { username: auth.user.username });
      if (problem) return reply.code(400).send({ error: 'weak_password', message: problem });

      ctx.users.setPassword(auth.user.id, await hashPassword(body.newPassword), false);
      // Other devices must log in again; this session stays.
      ctx.sessions.revokeAllForUser(auth.user.id, hashToken(auth.token));
      ctx.hub.closeUser(auth.user.id); // sockets reconnect with the surviving cookie
      ctx.audit.write({
        event: 'password_changed',
        userId: auth.user.id,
        username: auth.user.username,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      const fresh = ctx.users.getById(auth.user.id) as UserRow;
      return me(fresh, auth.session.expires_at);
    },
  );
}
