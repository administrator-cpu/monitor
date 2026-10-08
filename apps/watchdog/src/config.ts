export interface Config {
  targetUrl: URL;
  cronToken: string;
  resendApiKey: string;
  resendApiUrl: string;
  alertFrom: string;
  alertTo: string[];
  port: number;
  attempts: number;
  attemptDelayMs: number;
  attemptTimeoutMs: number;
  reminderAfterMs: number;
  flapWindowMs: number;
  recoverySuccesses: number;
  /** Names of the timing values that differ from the production defaults (logged at start). */
  overridden: string[];
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

const EMAIL = /^[^\s<>@,;"]+@[^\s<>@,;"]+\.[^\s<>@,;"]+$/;
const SENDER = /^(?:[^\r\n<>@]+<[^\s<>@,;]+@[^\s<>@,;]+>|[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+)$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

const DEFAULTS = {
  attempts: 3,
  attemptDelayMs: 10_000,
  attemptTimeoutMs: 8_000,
  reminderAfterMs: 60 * 60_000,
  flapWindowMs: 30 * 60_000,
  recoverySuccesses: 2,
};

/** Reads and validates the environment. Never echoes a secret in an error message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) problems.push(`${name} is required`);
    return v ?? '';
  };

  let targetUrl = new URL('https://invalid.invalid/');
  const rawTarget = need('TARGET_URL');
  if (rawTarget) {
    try {
      targetUrl = new URL(rawTarget);
      const local = LOOPBACK.has(targetUrl.hostname);
      if (targetUrl.protocol !== 'https:' && !(targetUrl.protocol === 'http:' && local)) {
        problems.push('TARGET_URL must start with https:// (http:// is accepted only for localhost testing)');
      }
      if (targetUrl.username || targetUrl.password) problems.push('TARGET_URL must not contain credentials');
    } catch {
      problems.push('TARGET_URL is not a valid URL');
    }
  }

  const cronToken = need('CRON_TOKEN');
  if (cronToken && cronToken.length < 32) problems.push('CRON_TOKEN must be at least 32 characters');

  const resendApiKey = need('RESEND_API_KEY');
  const alertFrom = need('ALERT_FROM');
  if (alertFrom && !SENDER.test(alertFrom)) problems.push('ALERT_FROM must look like name@example.com or Name <name@example.com>');

  const alertTo = need('ALERT_TO')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (alertTo.length === 0 && env.ALERT_TO) problems.push('ALERT_TO has no addresses');
  if (alertTo.length > 10) problems.push('ALERT_TO may list at most 10 addresses');
  for (const a of alertTo) if (!EMAIL.test(a)) problems.push('ALERT_TO contains an invalid address');

  const resendApiUrl = env.RESEND_API_URL?.trim() || 'https://api.resend.com/emails';
  try {
    const u = new URL(resendApiUrl);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
      problems.push('RESEND_API_URL must be https (http only for localhost)');
    }
  } catch {
    problems.push('RESEND_API_URL is not a valid URL');
  }

  const num = (name: string, def: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}`);
      return def;
    }
    return n;
  };
  const port = num('PORT', 10_000, 1, 65_535);
  const attempts = num('ATTEMPTS', DEFAULTS.attempts, 1, 10);
  const attemptDelayMs = num('ATTEMPT_DELAY_MS', DEFAULTS.attemptDelayMs, 0, 60_000);
  const attemptTimeoutMs = num('ATTEMPT_TIMEOUT_MS', DEFAULTS.attemptTimeoutMs, 100, 30_000);
  const reminderAfterMs = num('REMINDER_AFTER_MS', DEFAULTS.reminderAfterMs, 1_000, 24 * 3_600_000);
  const flapWindowMs = num('FLAP_WINDOW_MS', DEFAULTS.flapWindowMs, 0, 24 * 3_600_000);
  const recoverySuccesses = num('RECOVERY_SUCCESSES', DEFAULTS.recoverySuccesses, 1, 10);

  if (problems.length > 0) throw new ConfigError(problems);

  const overridden = (
    [
      ['ATTEMPTS', attempts, DEFAULTS.attempts],
      ['ATTEMPT_DELAY_MS', attemptDelayMs, DEFAULTS.attemptDelayMs],
      ['ATTEMPT_TIMEOUT_MS', attemptTimeoutMs, DEFAULTS.attemptTimeoutMs],
      ['REMINDER_AFTER_MS', reminderAfterMs, DEFAULTS.reminderAfterMs],
      ['FLAP_WINDOW_MS', flapWindowMs, DEFAULTS.flapWindowMs],
      ['RECOVERY_SUCCESSES', recoverySuccesses, DEFAULTS.recoverySuccesses],
    ] as const
  )
    .filter(([, v, d]) => v !== d)
    .map(([k]) => k);

  return {
    targetUrl, cronToken, resendApiKey, resendApiUrl, alertFrom, alertTo, port,
    attempts, attemptDelayMs, attemptTimeoutMs, reminderAfterMs, flapWindowMs, recoverySuccesses, overridden,
  };
}

/** What may appear in logs: no token, no key, no recipient addresses. */
export function describeConfig(c: Config): Record<string, unknown> {
  return {
    target: `${c.targetUrl.protocol}//${c.targetUrl.host}${c.targetUrl.pathname}`,
    recipients: c.alertTo.length,
    cronToken: 'set',
    resendApiKey: 'set',
    port: c.port,
    attempts: c.attempts,
    attemptDelayMs: c.attemptDelayMs,
    attemptTimeoutMs: c.attemptTimeoutMs,
    reminderAfterMs: c.reminderAfterMs,
    flapWindowMs: c.flapWindowMs,
    recoverySuccesses: c.recoverySuccesses,
    overridden: c.overridden,
  };
}
