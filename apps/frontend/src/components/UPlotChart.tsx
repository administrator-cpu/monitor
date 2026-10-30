'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type uPlot from 'uplot';
import { breakGaps } from '@cc/shared';
import 'uplot/dist/uPlot.min.css';

export interface ChartSeries {
  label: string;
  /** Name of a CSS variable, e.g. `--series-1`, so the chart follows the light/dark theme. */
  colorVar: string;
  /** Area fill under the line (default true). Turn off for secondary series so fills do not blend. */
  fill?: boolean;
}

interface Props {
  data: uPlot.AlignedData;
  series: ChartSeries[];
  ariaLabel: string;
  height?: number;
  /** Fixed y range, e.g. [0, 100] for percentages. Omit to auto-scale from zero. */
  yRange?: [number, number];
  format?: (v: number) => string;
}

const css = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** uPlot wrapper: dynamic import (uPlot touches `document` at load), resize-aware, theme-aware. */
export function UPlotChart({
  data,
  series,
  ariaLabel,
  height = 190,
  yRange,
  format = (v) => String(Math.round(v * 10) / 10),
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  // A stretch with no samples (agent stopped, monitor restarting) is drawn as a gap, not a line.
  const shown = useMemo(() => breakGaps(data) as uPlot.AlignedData, [data]);
  const latest = useRef(shown);
  latest.current = shown;
  const [scheme, setScheme] = useState(0);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const bump = () => setScheme((n) => n + 1);
    mq.addEventListener('change', bump);
    return () => mq.removeEventListener('change', bump);
  }, []);

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    void import('uplot').then(({ default: UPlot }) => {
      const el = host.current;
      if (disposed || !el) return;
      const muted = css('--muted');
      const grid = css('--border');
      const opts: uPlot.Options = {
        width: Math.max(240, el.clientWidth),
        height,
        padding: [8, 8, 0, 0],
        cursor: { drag: { x: false, y: false } },
        scales: {
          x: { time: true },
          y: { range: yRange ? () => yRange : (_u, _min, max) => [0, Math.max(1, max * 1.15)] },
        },
        axes: [
          { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
          {
            stroke: muted,
            grid: { stroke: grid, width: 1 },
            ticks: { stroke: grid },
            size: 64,
            values: (_u, vals) => vals.map((v) => format(v)),
          },
        ],
        series: [
          {},
          ...series.map((s) => {
            const color = css(s.colorVar);
            return {
              label: s.label,
              stroke: color,
              width: 1.6,
              fill: s.fill === false ? undefined : `color-mix(in srgb, ${color} 14%, transparent)`,
              points: { show: false },
              value: (_u: uPlot, v: number | null) => (v == null ? '—' : format(v)),
            } satisfies uPlot.Series;
          }),
        ],
      };
      plot.current = new UPlot(opts, latest.current, el);
      ro = new ResizeObserver(() => {
        if (plot.current && host.current)
          plot.current.setSize({ width: Math.max(240, host.current.clientWidth), height });
      });
      ro.observe(el);
    });
    return () => {
      disposed = true;
      ro?.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
    // The chart is rebuilt only when its shape or theme changes; data flows through setData below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheme, height, yRange?.[0], yRange?.[1], series.map((s) => s.label + s.colorVar).join('|')]);

  useEffect(() => {
    plot.current?.setData(shown);
  }, [shown]);

  return (
    <div
      ref={host}
      className="chart"
      role="img"
      aria-label={ariaLabel}
      data-points={data[0]?.length ?? 0}
    />
  );
}
