'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import type { AlignedData } from 'uplot';
import type { HostResponse, HostSeries } from '@cc/shared';
import { fetcher } from './api';
import { useLive } from './live';

const CAPACITY = 900; // 30 minutes at 2 s, matching the backend ring buffer

const empty = (): HostSeries => ({ ts: [], cpuPct: [], memPct: [], netRxBps: [], netTxBps: [] });

/**
 * Seeds the charts from the backend ring buffer (so a reload is never empty), then
 * extends them with each live sample. One point is added per distinct host sample time.
 */
export function useHostSeries() {
  const {
    data: seed,
    error,
    mutate,
  } = useSWR<HostResponse>('/host', fetcher, { refreshInterval: 10_000 });
  const { live } = useLive();
  const buf = useRef<HostSeries>(empty());
  const seeded = useRef(false);
  const [version, setVersion] = useState(0);

  // Seed once from the REST response; later refreshes only update the monitor-health card.
  useEffect(() => {
    if (!seed || seeded.current) return;
    seeded.current = true;
    buf.current = {
      ts: [...seed.series.ts],
      cpuPct: [...seed.series.cpuPct],
      memPct: [...seed.series.memPct],
      netRxBps: [...seed.series.netRxBps],
      netTxBps: [...seed.series.netTxBps],
    };
    setVersion((v) => v + 1);
  }, [seed]);

  // Extend with each live sample (skipping repeats of the same sample time).
  useEffect(() => {
    const h = live?.host;
    if (!h || !seeded.current) return;
    const t = Math.round(h.updatedAt / 1000);
    const b = buf.current;
    if (b.ts.length > 0 && t <= (b.ts[b.ts.length - 1] as number)) return;
    b.ts.push(t);
    b.cpuPct.push(h.cpuPct);
    b.memPct.push(h.memTotalBytes > 0 ? (h.memUsedBytes / h.memTotalBytes) * 100 : 0);
    b.netRxBps.push(h.netRxBps);
    b.netTxBps.push(h.netTxBps);
    if (b.ts.length > CAPACITY) {
      for (const k of Object.keys(b) as (keyof HostSeries)[]) b[k].shift();
    }
    setVersion((v) => v + 1);
  }, [live]);

  // `version` is the change signal: the arrays are mutated in place, so copy per version.
  const charts = useMemo(() => {
    const b = buf.current;
    return {
      cpu: [b.ts.slice(), b.cpuPct.slice()] as AlignedData,
      mem: [b.ts.slice(), b.memPct.slice()] as AlignedData,
      net: [b.ts.slice(), b.netRxBps.slice(), b.netTxBps.slice()] as AlignedData,
      points: b.ts.length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  return {
    ...charts,
    monitor: seed?.monitor,
    collectors: seed?.collectors,
    error,
    reload: mutate,
  };
}
