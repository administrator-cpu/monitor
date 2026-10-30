/**
 * The agent's environment (TRD 9.5). Secrets (`CC_ENROLL_TOKEN`) come from the root-only env file;
 * the host token is not configured here: the agent writes it to its state volume on enrollment.
 */
export interface AgentConfig {
  /** `https://monitor-api.thediv.in`, no trailing slash. */
  monitorUrl: string;
  enrollToken: string | null;
  /** Informational: the monitor uses the name the admin chose on the Hosts page. */
  hostName: string | null;
  /** `http://cc-docker-proxy:2375`; null switches container monitoring off. */
  dockerUrl: string | null;
  /** Compose projects to watch, e.g. `acs`. The agent's own project is always included. */
  projects: string[];
  /** The agent's own compose project; found from its own container when not set. */
  ownProject: string | null;
  /** Mount points to report, `/` by default. */
  disks: string[];
  actions: boolean;
  procRoot: string;
  hostRoot: string;
  hostRun: string;
  stateDir: string;
  intervalMs: number;
  /** Follow and ship container logs (M3); `CC_LOGS=off` switches it off. */
  logs: boolean;
  /** The disk buffer for log batches while the monitor is unreachable. */
  logBufferBytes: number;
  /** `CC_LOG_LINES_PER_S`: overrides the monitor's per-container limit; null takes the monitor's. */
  logLinesPerS: number | null;
}

export class ConfigError extends Error {}

const PROJECT = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const rawUrl = (env.CC_MONITOR_URL ?? '').trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError('CC_MONITOR_URL must be the monitor API address, e.g. https://monitor-api.thediv.in');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || env.CC_ALLOW_HTTP === '1'))) {
    // The host token travels in every request; plain HTTP only for a local demo.
    throw new ConfigError('CC_MONITOR_URL must use https:// (http:// only for localhost or with CC_ALLOW_HTTP=1)');
  }
  if (url.pathname !== '/' && url.pathname !== '') throw new ConfigError('CC_MONITOR_URL must not have a path');

  const projects = list(env.CC_PROJECTS);
  for (const p of projects) if (!PROJECT.test(p)) throw new ConfigError(`CC_PROJECTS: "${p}" is not a compose project name`);
  const own = env.CC_OWN_PROJECT?.trim() || null;
  if (own && !PROJECT.test(own)) throw new ConfigError('CC_OWN_PROJECT is not a compose project name');

  const disks = list(env.CC_DISKS);
  for (const d of disks) {
    if (!d.startsWith('/') || d.split('/').includes('..') || d.length > 200) {
      throw new ConfigError(`CC_DISKS: "${d}" must be an absolute mount point`);
    }
  }

  const actions = (env.CC_ACTIONS ?? 'on').trim().toLowerCase();
  if (actions !== 'on' && actions !== 'off') throw new ConfigError('CC_ACTIONS must be on or off');

  const logs = (env.CC_LOGS ?? 'on').trim().toLowerCase();
  if (logs !== 'on' && logs !== 'off') throw new ConfigError('CC_LOGS must be on or off');
  const bufferMb = Number(env.CC_LOG_BUFFER_MB ?? 50);
  if (!Number.isFinite(bufferMb) || bufferMb < 1 || bufferMb > 1000) throw new ConfigError('CC_LOG_BUFFER_MB must be between 1 and 1000');

  const rawLimit = env.CC_LOG_LINES_PER_S?.trim();
  const limit = rawLimit ? Number(rawLimit) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit < 10 || limit > 2000)) {
    throw new ConfigError('CC_LOG_LINES_PER_S must be a whole number from 10 to 2000');
  }

  const dockerUrl = (env.CC_DOCKER_URL ?? 'http://cc-docker-proxy:2375').trim();
  const interval = Number(env.CC_INTERVAL_S ?? 10);
  if (!Number.isFinite(interval) || interval < 2 || interval > 60) throw new ConfigError('CC_INTERVAL_S must be between 2 and 60');

  return {
    monitorUrl: url.origin,
    enrollToken: env.CC_ENROLL_TOKEN?.trim() || null,
    hostName: env.CC_HOST_NAME?.trim() || null,
    dockerUrl: dockerUrl === '' || dockerUrl === 'off' ? null : dockerUrl,
    projects,
    ownProject: own,
    disks: disks.length ? disks : ['/'],
    actions: actions === 'on',
    procRoot: env.CC_PROC ?? '/proc',
    hostRoot: env.CC_HOST_ROOT ?? '/host',
    hostRun: env.CC_HOST_RUN ?? '/host-run',
    stateDir: env.CC_STATE_DIR ?? '/var/lib/cc-agent',
    intervalMs: Math.round(interval * 1000),
    logs: logs === 'on',
    logBufferBytes: Math.round(bufferMb * 1024 * 1024),
    logLinesPerS: limit,
  };
}
