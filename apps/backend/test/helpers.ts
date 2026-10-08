import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { CSRF_HEADER, CSRF_VALUE } from '@cc/shared';
import { hashPassword } from '../src/auth/password';
import type { Config } from '../src/config';
import { createContext, type AppContext, type ContextOverrides } from '../src/context';
import { migrate, openDb, type Db } from '../src/db';
import { createLogger } from '../src/logger';
import { buildApp } from '../src/server';

export const ORIGIN = 'http://localhost:3000';
export const GOOD_PASSWORD = 'correct horse battery';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    bindHost: '127.0.0.1',
    portApi: 0,
    portIngest: 0,
    allowedOrigins: [ORIGIN],
    cookieSecure: false,
    cookieName: 'cc_session',
    sqlitePath: ':memory:',
    logRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-logs-')),
    logLevel: 'silent',
    logRequireSeparateVolume: false,
    pm2Enabled: false,
    resendApiUrl: 'http://127.0.0.1:1/emails',
    tlsCheckHosts: [],
    mongoProfileDbs: [],
    ...overrides,
  };
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  db: Db;
  clock: { t: number };
  close(): Promise<void>;
}

export async function makeApp(
  opts: { db?: Db; config?: Partial<Config>; clock?: { t: number }; overrides?: ContextOverrides } = {},
): Promise<TestApp> {
  const db = opts.db ?? openDb(':memory:');
  migrate(db);
  const clock = opts.clock ?? { t: 1_800_000_000_000 };
  const ctx = createContext({
    config: testConfig(opts.config),
    db,
    log: createLogger('silent'),
    now: () => clock.t,
    overrides: opts.overrides,
  });
  const app = await buildApp(ctx);
  await app.ready();
  return {
    app,
    ctx,
    db,
    clock,
    close: async () => {
      ctx.hub.stop();
      await app.close();
    },
  };
}

export async function addUser(
  t: TestApp,
  over: Partial<{
    username: string;
    role: 'admin' | 'engineer';
    password: string;
    mustChange: boolean;
    email: string;
  }> = {},
) {
  const username = over.username ?? 'owner';
  return t.ctx.users.create({
    username,
    displayName: username,
    email: over.email ?? `${username}@example.com`,
    role: over.role ?? 'admin',
    passwordHash: await hashPassword(over.password ?? GOOD_PASSWORD),
    mustChangePassword: over.mustChange ?? false,
  });
}

export const writeHeaders = (extra: Record<string, string> = {}) => ({
  origin: ORIGIN,
  [CSRF_HEADER]: CSRF_VALUE,
  ...extra,
});

export function cookieFrom(res: LightMyRequestResponse, name = 'cc_session'): string | null {
  const c = res.cookies.find((x) => x.name === name);
  return c ? c.value : null;
}

export async function login(
  t: TestApp,
  username = 'owner',
  password = GOOD_PASSWORD,
): Promise<{ res: LightMyRequestResponse; cookie: string | null }> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: writeHeaders(),
    payload: { username, password },
  });
  return { res, cookie: cookieFrom(res) };
}

export const authed = (cookie: string, extra: Record<string, string> = {}) => ({
  ...writeHeaders(extra),
  cookie: `cc_session=${cookie}`,
});

export function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  return path.join(dir, 'monitor.db');
}
