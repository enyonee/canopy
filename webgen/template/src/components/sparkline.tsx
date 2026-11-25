// A tiny trend line without a charts library: an SVG path with a soft gradient fill under it.
import { useId } from 'react';

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const id = `sp${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  if (values.length < 2) return null;
  const max = Math.max(...values), min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 28 - ((v - min) / span) * 24] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--chart-1)" stopOpacity="0.35" />
          <stop offset="1" stopColor="var(--chart-1)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L100 32 L0 32 Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="var(--chart-1)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
