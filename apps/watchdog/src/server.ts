import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { runCheck, type CheckOptions } from './check';
import { describeConfig, loadConfig, ConfigError, type Config } from './config';
import { Machine } from './machine';
import { resendSender, type Sender } from './mail';

const log = (msg: string, extra: Record<string, unknown> = {}): void =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

/** Compares through a hash so the comparison time does not depend on how much of the token matched. */
export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export interface AppDeps {
  config: Pick<Config, 'cronToken' | 'targetUrl' | 'attempts' | 'attemptDelayMs' | 'attemptTimeoutMs' | 'reminderAfterMs' | 'flapWindowMs' | 'recoverySuccesses'>;
  send: Sender;
  now?: () => number;
  check?: (o: CheckOptions) => ReturnType<typeof runCheck>;
  fetchImpl?: typeof fetch;
}

/** A check that has been running this long is considered stuck and no longer blocks new ones. */
const STUCK_AFTER_MS = 3 * 60_000;

export function createApp(d: AppDeps) {
  const now = d.now ?? Date.now;
  const check = d.check ?? runCheck;
  const machine = new Machine({
    now,
    send: d.send,
    reminderAfterMs: d.config.reminderAfterMs,
    flapWindowMs: d.config.flapWindowMs,
    recoverySuccesses: d.config.recoverySuccesses,
    log,
  });
  let running: { since: number; done: Promise<void> } | null = null;
  let unauthorized = 0;

  /** Starts a background check unless one is already running. Returns the promise for tests. */
  function trigger(): Promise<void> | null {
    const t = now();
    if (running && t - running.since < STUCK_AFTER_MS) return null;
    const slot = { since: t, done: Promise.resolve() as Promise<void> };
    running = slot;
    slot.done = (async () => {
      try {
        const r = await check({
          url: d.config.targetUrl,
          attempts: d.config.attempts,
          delayMs: d.config.attemptDelayMs,
          timeoutMs: d.config.attemptTimeoutMs,
          fetchImpl: d.fetchImpl,
        });
        await machine.onCheck(r);
      } catch (err) {
        log('check crashed', { error: err instanceof Error ? err.message : 'error' });
      } finally {
        if (running === slot) running = null;
      }
    })();
    return slot.done;
  }

  const handler: http.RequestListener = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : 'ok');
      return;
    }
    if (url.pathname === '/ping') {
      if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
      const given = req.headers['x-cron-token'];
      if (!tokenMatches(Array.isArray(given) ? given[0] : given, d.config.cronToken)) {
        unauthorized += 1;
        if (unauthorized === 1 || unauthorized % 100 === 0) log('unauthorized ping', { total: unauthorized });
        return json(401, { error: 'unauthorized' });
      }
      const started = trigger() !== null;
      return json(200, { ...machine.state(), checking: running !== null, checkStarted: started });
    }
    json(404, { error: 'not_found' });
  };

  return { handler, machine, trigger, idle: () => running?.done ?? Promise.resolve() };
}

function main(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(1);
  }
  const bootId = randomBytes(4).toString('hex');
  const send = resendSender(config, bootId, (m, x) => log(m, x));
  const app = createApp({ config, send });
  const server = http.createServer(app.handler);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(config.port, '0.0.0.0', () => {
    log('watchdog started', { bootId, ...describeConfig(config) });
    if (config.overridden.length > 0) log('timing values differ from the production defaults', { overridden: config.overridden });
  });
  const stop = (): void => {
    log('shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) main();
