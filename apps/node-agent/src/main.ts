import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeAgent, type TrackerStore } from './agent';
import { EnrollError, MonitorClient } from './client';
import { ConfigError, loadConfig } from './config';
import { DockerClient } from './docker';
import { jsonLog } from './log';
import { HostReader } from './proc';
import { AGENT_VERSION } from './version';

/**
 * cc-node-agent: reports this Linux host and its compose services to the Command Center monitor
 * (TRD 14.2 to 14.5). Outbound only: it opens no port and only ever calls the monitor and the
 * Docker proxy.
 */
async function main(): Promise<void> {
  const log = jsonLog();
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    log.error(e instanceof ConfigError ? e.message : String(e));
    process.exit(2);
  }
  log.info('starting cc-node-agent', {
    version: AGENT_VERSION,
    monitor: config.monitorUrl,
    projects: config.projects,
    disks: config.disks,
    docker: config.dockerUrl,
    actions: config.actions ? 'on' : 'off',
  });

  const client = new MonitorClient({
    url: config.monitorUrl,
    stateDir: config.stateDir,
    enrollToken: config.enrollToken,
    version: AGENT_VERSION,
    // The host's own name is not visible inside the container; CC_HOST_NAME is the closest record.
    hostname: config.hostName ?? os.hostname(),
    log,
  });

  // Enrollment problems are retried: the monitor may be restarting or the token not yet saved.
  for (let wait = 10_000; ; wait = Math.min(wait * 2, 600_000)) {
    try {
      await client.init();
      break;
    } catch (e) {
      const code = e instanceof EnrollError ? e.code : 'error';
      log.error(e instanceof Error ? e.message : String(e), { code, retryInS: wait / 1000 });
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  const reader = new HostReader({ procRoot: config.procRoot, hostRun: config.hostRun, disks: config.disks });
  await reader.prime();
  const agent = new NodeAgent({
    config,
    client,
    reader,
    docker: config.dockerUrl ? new DockerClient(config.dockerUrl) : null,
    log,
    hostname: os.hostname(),
    store: fileStore(path.join(config.stateDir, 'containers.json')),
  });
  await agent.loadState();
  agent.start();

  const stop = (signal: string): void => {
    log.info('stopping', { signal });
    void agent.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

/** The tracker's state as JSON on the state volume, replaced atomically (write, then rename). */
function fileStore(file: string): TrackerStore {
  return {
    load: () =>
      fs.readFile(file, 'utf8').then(
        (s) => JSON.parse(s) as unknown,
        (e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        },
      ),
    save: async (snap) => {
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(snap), { mode: 0o600 });
      await fs.rename(tmp, file);
    },
  };
}

void main();
