/**
 * What the monitor takes from PM2. Only whitelisted fields cross this boundary: PM2 process
 * records carry each application's full environment (including secrets), which must never be
 * copied, logged or stored.
 */
export interface Pm2Proc {
  name: string;
  pmId: number;
  status: string;
  /** PM2's cumulative restart counter for this instance. */
  restarts: number;
  /** When the instance last started (ms since epoch), null if unknown. */
  pmUptime: number | null;
  /** Percent of one core. */
  cpu: number;
  memory: number;
  /** PM2 modules (for example pm2-logrotate) are not services. */
  isModule: boolean;
  /** PM2's own stdout / stderr log files (paths only; used to show recent history). */
  outLog?: string | null;
  errLog?: string | null;
}

export interface Pm2LogPacket {
  name: string;
  pmId: number;
  stream: 'out' | 'err';
  data: string;
  at: number;
}

export interface Pm2EventPacket {
  name: string;
  pmId: number | null;
  /** start, stop, restart, exit, online, exception, restart overlimit, delete, reload. */
  event: string;
  at: number;
  exitCode: number | null;
  signal: string | null;
  isModule: boolean;
  /** Exception message, cut to a short length. */
  message?: string;
}

export interface Pm2Handlers {
  onLogs(items: Pm2LogPacket[]): void;
  onEvents(items: Pm2EventPacket[]): void;
  /** The event bus connection ended (daemon restarted or stopped). */
  onBusClosed(): void;
}

/**
 * View of PM2 plus exactly two changes: restart and stop of one process instance, addressed by
 * its numeric id. There is deliberately no delete, kill, reload, free-text name or command here.
 * (Start is a restart of a stopped instance.)
 */
export interface Pm2Source {
  /** Verifies the daemon is reachable and connects. Never starts a daemon. */
  connect(): Promise<void>;
  list(): Promise<Pm2Proc[]>;
  /** Restarts (which also starts a stopped instance) or stops one instance by its PM2 id. */
  act(action: 'restart' | 'stop', pmId: number): Promise<void>;
  startBus(handlers: Pm2Handlers): Promise<void>;
  stopBus(): Promise<void>;
  /** Releases everything, including a worker thread when there is one. */
  dispose(): Promise<void>;
}

export const EVENT_ALLOWLIST = new Set([
  'start',
  'stop',
  'restart',
  'exit',
  'online',
  'exception',
  'restart overlimit',
  'delete',
  'reload',
]);
