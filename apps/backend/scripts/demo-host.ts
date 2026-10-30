/**
 * The second host of `pnpm demo` (phase 11 M2): a pretend Ubuntu server reported by the real node
 * agent (`@cc/node-agent`) through the backend's own `/agent/v1` routes, exactly as on acs-prod.
 *
 *  - a host row named DEMO_HOST_NAME (ubuntu-acs), enrolled with a fresh one-time token;
 *  - a pretend /proc (two cores, ens3 plus Docker's interfaces, one disk) whose counters move;
 *  - a pretend Docker API, as cc-docker-proxy would pass it through: the nine `acs` containers of
 *    V20 and the agent's own two, with an event stream. `cpe-sim` stops every DEMO_FLAP_S seconds
 *    (300) for 120 s, so "service down" opens and resolves on the demo host; 0 keeps it as it
 *    started, which is running unless DEMO_CPE_DOWN=1.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AppContext } from '../src/context';

const OWN_ID = 'c0ffee000001aabbccddeeff'; // the agent's container id; its "hostname" is the first 12 characters

const labels = (project: string, service: string) => ({
  'com.docker.compose.project': project,
  'com.docker.compose.service': service,
});

export async function startDemoHost(ctx: AppContext, apiBase: string, dir: string): Promise<() => Promise<void>> {
  const name = process.env.DEMO_HOST_NAME ?? 'ubuntu-acs';
  const flapS = Math.max(0, Number(process.env.DEMO_FLAP_S ?? 300));
  const existing = ctx.hosts.list().find((h) => h.name.toLowerCase() === name.toLowerCase());
  const { token } = existing
    ? ctx.hosts.issueEnrollToken(existing.id, 60)
    : ctx.hosts.create({ name, os: 'linux', notes: 'pnpm demo: pretend /proc and Docker', createdBy: null }, 60);

  // --- pretend /proc --------------------------------------------------------------------------------
  const procRoot = path.join(dir, 'host-proc');
  const hostRun = path.join(dir, 'host-run');
  const hostRoot = path.join(dir, 'host-root');
  for (const d of [path.join(procRoot, '1', 'net'), hostRun, hostRoot]) fs.mkdirSync(d, { recursive: true });
  const c = { busy: [100_000, 100_000], idle: [900_000, 900_000], rx: 5e9, tx: 2e9, read: 1e7, written: 3e7 };
  const writeProc = (): void => {
    const cpu = (n: string, b: number, i: number) => `${n} ${b} 0 0 ${i} 0 0 0 0 0 0`;
    fs.writeFileSync(
      path.join(procRoot, 'stat'),
      [cpu('cpu ', c.busy[0]! + c.busy[1]!, c.idle[0]! + c.idle[1]!), cpu('cpu0', c.busy[0]!, c.idle[0]!), cpu('cpu1', c.busy[1]!, c.idle[1]!)].join('\n'),
    );
    const usedKb = 2_400_000 + Math.floor(Math.random() * 300_000);
    fs.writeFileSync(
      path.join(procRoot, 'meminfo'),
      `MemTotal:        8148000 kB\nMemFree:          900000 kB\nMemAvailable:    ${8_148_000 - usedKb} kB\nSwapTotal:       2097148 kB\nSwapFree:        2000000 kB\n`,
    );
    fs.writeFileSync(path.join(procRoot, 'uptime'), `${Math.floor(process.uptime()) + 1_900_000}.12 0.00\n`);
    const row = (n: string, r: number, t: number) => `  ${n}: ${Math.floor(r)} 0 0 0 0 0 0 0 ${Math.floor(t)} 0 0 0 0 0 0 0`;
    fs.writeFileSync(path.join(procRoot, '1', 'net', 'dev'), ['h1', 'h2', row('lo', 1e9, 1e9), row('ens3', c.rx, c.tx), row('docker0', 1e8, 1e8), row('veth1a2b', 1e8, 1e8)].join('\n'));
    fs.writeFileSync(path.join(procRoot, '1', 'mountinfo'), '22 1 252:1 / / rw,relatime shared:1 - ext4 /dev/vda1 rw\n');
    fs.writeFileSync(path.join(procRoot, 'diskstats'), ` 252 1 vda1 0 0 ${Math.floor(c.read)} 0 0 0 ${Math.floor(c.written)} 0 0 0 0\n`);
  };
  writeProc();
  const procTimer = setInterval(() => {
    for (const i of [0, 1]) {
      const busy = Math.floor(50 + Math.random() * 60); // of 200 jiffies per 2 s
      c.busy[i]! += busy;
      c.idle[i]! += 200 - busy;
    }
    c.rx += 40_000 + Math.random() * 400_000;
    c.tx += 20_000 + Math.random() * 200_000;
    c.read += Math.random() * 200;
    c.written += 200 + Math.random() * 2_000;
    writeProc();
  }, 2_000);

  // --- pretend Docker API (what cc-docker-proxy lets through) -------------------------------------------
  const started = Date.now();
  const acs = ['api', 'dashboard', 'caddy', 'mongo', 'genieacs-nbi', 'genieacs-cwmp', 'genieacs-fs', 'genieacs-ui', 'cpe-sim'];
  const containers = [
    ...acs.map((s, i) => ({ Id: `acs${String(i).padStart(9, '0')}`, service: s, project: 'acs', health: s === 'mongo' || s === 'api' })),
    { Id: OWN_ID, service: 'cc-node-agent', project: 'cc-agent', health: false },
    { Id: 'c0ffee000002aabbccddeeff', service: 'cc-docker-proxy', project: 'cc-agent', health: false },
  ];
  let cpeRunning = process.env.DEMO_CPE_DOWN !== '1'; // DEMO_CPE_DOWN=1: cpe-sim starts stopped (the e2e tests)
  const streams = new Set<http.ServerResponse>();
  const emit = (id: string, action: string, attrs: Record<string, string> = {}): void => {
    const x = containers.find((k) => k.Id === id)!;
    const t = Date.now();
    const line = JSON.stringify({ Type: 'container', Action: action, Actor: { ID: id, Attributes: { ...labels(x.project, x.service), ...attrs } }, time: Math.floor(t / 1000), timeNano: t * 1e6 });
    for (const s of streams) s.write(line + '\n');
  };
  const docker = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://docker');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && u.pathname === '/containers/json') {
      const up = Math.floor((Date.now() - started) / 60_000) + 5;
      return res.end(
        JSON.stringify(
          containers.map((x) => {
            const running = x.service !== 'cpe-sim' || cpeRunning;
            return {
              Id: x.Id,
              Names: [`/${x.project}-${x.service}-1`],
              State: running ? 'running' : 'exited',
              Status: running ? `Up ${up} minutes${x.health ? ' (healthy)' : ''}` : 'Exited (137) 1 minute ago',
              Labels: labels(x.project, x.service),
            };
          }),
        ),
      );
    }
    if (req.method === 'GET' && /^\/containers\/[^/]+\/stats$/.test(u.pathname)) {
      const heavy = u.pathname.includes('acs000000005') || u.pathname.includes('acs000000003'); // genieacs-cwmp, mongo
      const total = 1e12 + Date.now() * 1e3;
      return res.end(
        JSON.stringify({
          cpu_stats: { cpu_usage: { total_usage: total }, system_cpu_usage: total * 20, online_cpus: 2 },
          precpu_stats: { cpu_usage: { total_usage: total - (heavy ? 3e7 : 4e6) * (0.5 + Math.random()) }, system_cpu_usage: total * 20 - 2e9 },
          memory_stats: { usage: (heavy ? 420e6 : 90e6) + Math.random() * 20e6, stats: { inactive_file: 10e6 } },
        }),
      );
    }
    if (req.method === 'GET' && u.pathname === '/events') {
      res.writeHead(200);
      res.flushHeaders();
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    res.statusCode = 403;
    res.end('{"message":"forbidden by cc-docker-proxy"}');
  });
  await new Promise<void>((r) => docker.listen(0, '127.0.0.1', r));
  const dockerUrl = `http://127.0.0.1:${(docker.address() as { port: number }).port}`;

  const cpeId = containers.find((x) => x.service === 'cpe-sim')!.Id;
  const timers: NodeJS.Timeout[] = [procTimer];
  if (flapS > 0) {
    timers.push(
      setInterval(() => {
        cpeRunning = false;
        emit(cpeId, 'kill', { signal: '9' });
        emit(cpeId, 'die', { exitCode: '137' });
        emit(cpeId, 'stop');
        timers.push(
          setTimeout(() => {
            cpeRunning = true;
            emit(cpeId, 'start');
          }, 120_000),
        );
      }, flapS * 1000),
    );
  }

  // --- the real node agent ------------------------------------------------------------------------------
  const { NodeAgent, MonitorClient, HostReader, DockerClient, AGENT_VERSION } = await import('@cc/node-agent');
  const log = {
    info: (msg: string, f?: Record<string, unknown>) => ctx.log.info({ demoHost: name, ...f }, `node agent: ${msg}`),
    warn: (msg: string, f?: Record<string, unknown>) => ctx.log.warn({ demoHost: name, ...f }, `node agent: ${msg}`),
    error: (msg: string, f?: Record<string, unknown>) => ctx.log.error({ demoHost: name, ...f }, `node agent: ${msg}`),
  };
  const stateDir = path.join(dir, 'agent-state');
  const client = new MonitorClient({ url: apiBase, stateDir, enrollToken: token, version: AGENT_VERSION, hostname: 'acs-prod', log });
  await client.init();
  const reader = new HostReader({ procRoot, hostRun, disks: ['/'] });
  await reader.prime();
  const agent = new NodeAgent({
    config: {
      monitorUrl: apiBase,
      enrollToken: token,
      hostName: 'acs-prod',
      dockerUrl,
      projects: ['acs'],
      ownProject: null,
      disks: ['/'],
      actions: false,
      procRoot,
      hostRoot,
      hostRun,
      stateDir,
      intervalMs: 10_000,
    },
    client,
    reader,
    docker: new DockerClient(dockerUrl),
    log,
    hostname: OWN_ID.slice(0, 12),
  });
  agent.start();
  ctx.log.info({ host: name, docker: dockerUrl, flapSeconds: flapS }, 'demo host ready: switch to it on the Host and Services pages');

  return async () => {
    for (const t of timers) clearInterval(t);
    await agent.stop();
    for (const s of streams) s.end();
    docker.closeAllConnections();
    await new Promise<void>((r) => docker.close(() => r()));
  };
}
