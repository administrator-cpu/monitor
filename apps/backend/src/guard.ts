import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRow } from './auth/sessions';
import type { UserRow } from './auth/users';
import type { AppContext } from './context';

export interface AuthContext {
  user: UserRow;
  session: SessionRow;
  token: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function cookieOptions(ctx: AppContext) {
  return {
    path: '/',
    httpOnly: true,
    secure: ctx.config.cookieSecure,
    sameSite: 'lax' as const,
    // No `domain`: required for the __Host- prefix and keeps the cookie host-only.
  };
}

export function setSessionCookie(
  ctx: AppContext,
  reply: FastifyReply,
  token: string,
  expiresAt: number,
): void {
  const maxAge = Math.max(1, Math.floor((expiresAt - ctx.now()) / 1000));
  reply.setCookie(ctx.config.cookieName, token, { ...cookieOptions(ctx), maxAge });
}

export function clearSessionCookie(ctx: AppContext, reply: FastifyReply): void {
  reply.clearCookie(ctx.config.cookieName, cookieOptions(ctx));
}

export interface GuardOptions {
  admin?: boolean;
  /** Admins, and engineers an admin has allowed to start, stop and restart services. */
  operate?: boolean;
  /** Allow users who still have to change their password (me, logout, change-password). */
  allowMustChange?: boolean;
}

/** Fastify preHandler: requires a valid session and, optionally, the admin role. */
export function requireUser(ctx: AppContext, opts: GuardOptions = {}) {
  return async function guard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = req.cookies?.[ctx.config.cookieName];
    if (!token) {
      await reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    const r = ctx.sessions.validate(token);
    if (!r.ok) {
      if (r.reason === 'expired' || r.reason === 'idle') {
        ctx.audit.write({
          event: 'session_expired',
          userId: r.userId,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          detail: { reason: r.reason },
        });
      }
      clearSessionCookie(ctx, reply);
      await reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    if (r.user.must_change_password === 1 && !opts.allowMustChange) {
      await reply.code(403).send({
        error: 'password_change_required',
        message: 'You must change your password before continuing.',
      });
      return;
    }
    if (opts.admin && r.user.role !== 'admin') {
      await reply.code(403).send({ error: 'forbidden' });
      return;
    }
    if (opts.operate && r.user.role !== 'admin' && r.user.can_operate !== 1) {
      await reply.code(403).send({ error: 'forbidden', message: 'You are not allowed to operate services.' });
      return;
    }
    req.auth = { user: r.user, session: r.session, token };
  };
}
