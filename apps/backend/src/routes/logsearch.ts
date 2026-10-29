import type { FastifyInstance } from 'fastify';
import { logSearchSchema, spanLabel, type LogSearchResponse } from '@cc/shared';
import type { AppContext } from '../context';
import { requireUser } from '../guard';
import { rangeLimits } from '../limits';
import { safeDirName } from '../logs/files';
import { regexProblem } from '../logs/search';
import { SearchBusyError } from '../logs/searcher';

const SPECIAL = new Set(['_nginx', '_monitor']);

export function logSearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Raw logs can hold emails and tokens, so searching is limited to logged-in users and every search is audited.
  app.post('/logs/search', { preHandler: requireUser(ctx) }, async (req, reply): Promise<LogSearchResponse | void> => {
    const parsed = logSearchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'The search request is not valid.' });
    const q = parsed.data;
    // Log files older than `logs.retention_hours` are deleted, so a longer range would scan nothing more.
    const maxMs = rangeLimits(ctx.settings).logSearchMaxMs;
    if (q.from >= q.to || q.to - q.from > maxMs) {
      return reply.code(400).send({ error: 'invalid_request', message: `The time range must be positive and at most ${spanLabel(maxMs)}.` });
    }
    if (q.regex && q.query !== '') {
      const problem = regexProblem(q.query);
      if (problem) return reply.code(400).send({ error: 'invalid_regex', message: problem });
    }
    const known = new Set(ctx.services.list(true).map((s) => s.pm2_name));
    const unknown = q.services.filter((s) => !SPECIAL.has(s) && !known.has(s));
    if (unknown.length > 0) return reply.code(400).send({ error: 'unknown_service', message: 'One of the services is not known.' });

    const max = ctx.settings.get('logs.search_max_results');
    const actor = req.auth!.user;
    try {
      const res = await ctx.searcher.search(actor.id, {
        root: ctx.config.logRoot,
        dirs: [...new Set(q.services.map((s) => (SPECIAL.has(s) ? s : safeDirName(s))))],
        from: q.from,
        to: q.to,
        stream: q.stream,
        query: q.query,
        regex: q.regex,
        caseSensitive: q.caseSensitive,
        limit: Math.min(q.limit ?? max, max),
        context: q.context,
        order: q.order,
      });
      ctx.audit.write({
        event: 'log_search',
        userId: actor.id,
        username: actor.username,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        detail: {
          services: q.services, from: q.from, to: q.to, stream: q.stream, query: q.query, regex: q.regex,
          matched: res.matched, truncated: res.truncated, timedOut: res.timedOut,
        },
      });
      return res;
    } catch (e) {
      if (e instanceof SearchBusyError) {
        return reply.code(429).send({
          error: 'search_busy',
          message: e.scope === 'user' ? 'You already have a search running. Wait for it to finish.' : 'Several searches are running. Try again in a moment.',
        });
      }
      ctx.log.error({ err: e }, 'log search failed');
      return reply.code(500).send({ error: 'search_failed', message: 'The search could not be completed.' });
    }
  });
}
