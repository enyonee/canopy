// Inline illustrations for empty and refused states: plain SVG in the theme's colours, no files, no network.
import { cn } from '@/lib/utils';

const base = { fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export function EmptyBoxArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 120" className={cn('h-28 w-auto', className)} aria-hidden="true">
      <ellipse cx="80" cy="104" rx="56" ry="8" className="fill-primary/10" />
      <path d="M36 46 80 28l44 18v40L80 104 36 86Z" className="fill-card stroke-primary/40" strokeWidth="2" {...base} />
      <path d="M36 46 80 64l44-18M80 64v40" className="stroke-primary/40" strokeWidth="2" {...base} />
      <path d="M36 46 22 32l44-18 14 14M124 46l14-14-44-18-14 14" className="fill-primary/8 stroke-primary/40" strokeWidth="2" {...base} />
      <circle cx="128" cy="18" r="4" className="fill-primary/40" />
      <circle cx="140" cy="34" r="2.5" className="fill-primary/25" />
      <circle cx="24" cy="70" r="3" className="fill-primary/25" />
    </svg>
  );
}

export function SearchArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 120" className={cn('h-28 w-auto', className)} aria-hidden="true">
      <ellipse cx="80" cy="106" rx="50" ry="7" className="fill-primary/10" />
      <rect x="34" y="22" width="70" height="80" rx="10" className="fill-card stroke-primary/35" strokeWidth="2" />
      <path d="M48 42h42M48 56h30M48 70h36" className="stroke-primary/25" strokeWidth="4" {...base} />
      <circle cx="106" cy="66" r="20" className="fill-card stroke-primary" strokeWidth="4" />
      <path d="m121 81 14 14" className="stroke-primary" strokeWidth="6" {...base} />
      <path d="M99 60l14 12M113 60 99 72" className="stroke-primary/50" strokeWidth="3" {...base} />
    </svg>
  );
}

export function LockArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 120" className={cn('h-28 w-auto', className)} aria-hidden="true">
      <ellipse cx="80" cy="106" rx="44" ry="7" className="fill-primary/10" />
      <path d="M58 52V40a22 22 0 0 1 44 0v12" className="stroke-primary/50" strokeWidth="6" {...base} />
      <rect x="46" y="50" width="68" height="50" rx="12" className="fill-card stroke-primary/40" strokeWidth="2" />
      <circle cx="80" cy="72" r="7" className="fill-primary/60" />
      <path d="M80 78v10" className="stroke-primary/60" strokeWidth="5" {...base} />
    </svg>
  );
}
