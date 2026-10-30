import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** /proc as the agent sees it on acs-prod (V21): two cores, ens3 plus Docker's interfaces. */
export function procFixture(over: Partial<Record<string, string>> = {}): { procRoot: string; hostRun: string; hostRoot: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-node-agent-'));
  const procRoot = path.join(dir, 'proc');
  const hostRun = path.join(dir, 'host-run');
  const hostRoot = path.join(dir, 'host');
  fs.mkdirSync(path.join(procRoot, '1', 'net'), { recursive: true });
  fs.mkdirSync(hostRun);
  fs.mkdirSync(hostRoot);
  const files: Record<string, string> = {
    stat: statText(1000, 4000),
    meminfo: [
      'MemTotal:        8000000 kB',
      'MemFree:          500000 kB',
      'MemAvailable:    6000000 kB',
      'Buffers:          100000 kB',
      'Cached:          2000000 kB',
      'SwapTotal:       1000000 kB',
      'SwapFree:         750000 kB',
    ].join('\n'),
    uptime: '86400.55 170000.10\n',
    '1/net/dev': netText(1_000_000, 2_000_000),
    '1/mountinfo': [
      '22 1 252:1 / / rw,relatime shared:1 - ext4 /dev/vda1 rw',
      '25 22 0:22 / /run rw,nosuid shared:5 - tmpfs tmpfs rw',
      '30 22 252:16 / /mnt/data\\040disk rw shared:9 - ext4 /dev/vdb rw',
    ].join('\n'),
    diskstats: diskText(1000, 2000),
    ...over,
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(procRoot, name), text!);
  return { procRoot, hostRun, hostRoot, dir };
}

/** Busy and idle jiffies split evenly over two cores. */
export function statText(busy: number, idle: number): string {
  const line = (n: string, b: number, i: number) => `${n} ${b} 0 0 ${i} 0 0 0 0 0 0`;
  return [line('cpu ', busy, idle), line('cpu0', busy / 2, idle / 2), line('cpu1', busy / 2, idle / 2), 'intr 1 2 3', 'ctxt 5'].join('\n');
}

export function netText(rx: number, tx: number): string {
  const row = (name: string, r: number, t: number) => `  ${name}: ${r} 10 0 0 0 0 0 0 ${t} 10 0 0 0 0 0 0`;
  return [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    row('lo', 999_999, 999_999),
    row('ens3', rx, tx),
    row('docker0', 5_000, 5_000),
    row('br-1a2b3c', 7_000, 7_000),
    row('veth12ab', 9_000, 9_000),
  ].join('\n');
}

/** vda1 (252:1) with the given sectors read and written. */
export function diskText(read: number, written: number): string {
  return [
    ` 252       0 vda 100 0 ${read * 2} 0 100 0 ${written * 2} 0 0 0 0`,
    ` 252       1 vda1 90 0 ${read} 0 90 0 ${written} 0 0 0 0`,
    ` 252      16 vdb 1 0 8 0 1 0 8 0 0 0 0`,
  ].join('\n');
}

export interface FakeServer {
  url: string;
  close(): Promise<void>;
}

export function serve(handler: http.RequestListener): Promise<FakeServer> {
  const server = http.createServer(handler);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    }),
  );
}

export const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
