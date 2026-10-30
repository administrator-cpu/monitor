import {
  LOCAL_HOST_ID,
  logKeyOf,
  parseLogKey,
  type AgentLogs,
  type AgentLogsResponse,
  type LogStream,
} from '@cc/shared';
import type { HostRow, HostsRepo } from '../hosts/repo';
import type { ServicesRepo } from '../pm2/services';
import { hostServiceDir, safeDirName } from './files';
import { SPECIAL_DIRS, type LogPipeline } from './pipeline';

export interface RemoteLogsDeps {
  services: ServicesRepo;
  hosts: HostsRepo;
  pipeline: LogPipeline;
  linesPerS: () => number;
  now: () => number;
}

/**
 * Container logs from agent hosts (TRD 14.5, M3). Each batch belongs to one service of the
 * sending host; its lines go through the same pipeline as host 1's (live tail, hourly files,
 * retention, search) under the service's log key, in `@<host name>/<project>.<service>`.
 *
 *  - Lines for a service the monitor does not know (the agent saw the container before the next
 *    metrics report did) or one excluded on its page are not stored; they are counted on the host.
 *  - Lines the agent dropped over its per-container limit, or from its full disk buffer, are
 *    counted per service, and a line saying how many is added to the service's log, so a search or
 *    the live view shows where lines are missing.
 */
export class RemoteLogs {
  readonly since: number;
  private stats = new Map<number, { lines: number; dropped: number }>();

  constructor(private readonly d: RemoteLogsDeps) {
    this.since = d.now();
  }

  accept(host: HostRow, body: AgentLogs): AgentLogsResponse {
    const counts = this.d.hosts.countsOf(host.id);
    for (const b of body.batches) {
      counts.logLines += b.lines.length;
      counts.logDropped += b.dropped;
      const row = this.d.services.getBySource(host.id, b.service);
      if (!row || row.kind !== 'container' || row.log_excluded === 1) {
        counts.logIgnored += b.lines.length;
        continue;
      }
      const st = this.stats.get(row.id) ?? { lines: 0, dropped: 0 };
      this.stats.set(row.id, st);
      st.lines += b.lines.length;
      st.dropped += b.dropped;
      const lines: { ts: number; s: LogStream; msg: string }[] = b.lines;
      if (b.dropped > 0) {
        const last = b.lines.length > 0 ? b.lines[b.lines.length - 1]!.ts : this.d.now();
        lines.push({
          ts: last,
          s: 'err',
          msg: `[monitor] ${b.dropped} line${b.dropped === 1 ? '' : 's'} dropped by the agent on ${host.name} (over the limit of ${this.d.linesPerS()} lines/s, or its buffer was full)`,
        });
      }
      this.d.pipeline.ingestLines(logKeyOf(host.id, row.source_key), hostServiceDir(host.name, row.source_key), lines);
    }
    return this.answer(host.id);
  }

  /** What the agent needs to know: the services not to follow and its line limit. */
  answer(hostId: number): AgentLogsResponse {
    return {
      excluded: this.d.services
        .list(true, hostId)
        .filter((r) => r.kind === 'container' && r.log_excluded === 1)
        .map((r) => r.source_key),
      linesPerS: this.d.linesPerS(),
    };
  }

  statsOf(serviceId: number): { lines: number; dropped: number; since: number } {
    const s = this.stats.get(serviceId);
    return { lines: s?.lines ?? 0, dropped: s?.dropped ?? 0, since: this.since };
  }
}

/**
 * The folder of a log stream named in a search or a live-tail subscription: `_nginx` and
 * `_monitor`, a host 1 PM2 name, or the log key of a container service on another host. Null for
 * a name the monitor does not know, which the caller refuses.
 */
export function logDirOf(
  key: string,
  services: Pick<ServicesRepo, 'getBySource'>,
  hosts: Pick<HostsRepo, 'get'>,
): string | null {
  if (Object.hasOwn(SPECIAL_DIRS, key)) return key;
  const { hostId, sourceKey } = parseLogKey(key);
  const row = services.getBySource(hostId, sourceKey);
  if (!row) return null;
  if (hostId === LOCAL_HOST_ID) return safeDirName(sourceKey);
  const host = hosts.get(hostId);
  return host ? hostServiceDir(host.name, sourceKey) : null;
}
